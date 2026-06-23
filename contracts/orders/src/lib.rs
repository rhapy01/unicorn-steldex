#![no_std]
//! On-chain resting limit / stop-loss / take-profit orders.
//! Escrows token_in in instance storage; anyone may fill when price triggers.
use soroban_sdk::{
    contract, contractimpl, contracttype,
    token::TokenClient,
    Address, Env, Vec,
};

mod pool_interface {
    use soroban_sdk::{contractclient, Address, Env};

    #[contractclient(name = "PoolClient")]
    pub trait PoolTrait {
        fn swap(
            env: Env,
            recipient: Address,
            zero_for_one: bool,
            amount_specified: i128,
            sqrt_price_limit: u128,
        ) -> (i128, i128);
        fn sqrt_price(env: Env) -> u128;
        fn token0(env: Env) -> Address;
        fn token1(env: Env) -> Address;
    }
}

use pool_interface::PoolClient;

const STATUS_OPEN: u32 = 0;
const STATUS_FILLED: u32 = 1;
const STATUS_CANCELLED: u32 = 2;
const STATUS_EXPIRED: u32 = 3;

#[derive(Clone)]
#[contracttype]
pub struct Order {
    pub owner: Address,
    pub pool: Address,
    pub token_in: Address,
    pub zero_for_one: bool,
    pub amount_in: u128,
    pub min_amount_out: u128,
    pub trigger_sqrt_price: u128,
    pub order_type: u32,
    pub expiry_ledger: u32,
    pub status: u32,
    pub created_at: u64,
}

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    NextId,
    Order(u64),
    OpenIds,
}

#[contract]
pub struct Orders;

#[contractimpl]
impl Orders {
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::NextId, &1u64);
        env.storage().instance().set(&DataKey::OpenIds, &Vec::<u64>::new(&env));
    }

    /// Place a resting order. Escrows `token_in` from owner.
    /// order_type: 0=Limit, 1=StopLoss, 2=TakeProfit
    pub fn place_order(
        env: Env,
        owner: Address,
        pool: Address,
        token_in: Address,
        zero_for_one: bool,
        amount_in: u128,
        min_amount_out: u128,
        trigger_sqrt_price: u128,
        order_type: u32,
        expiry_ledger: u32,
    ) -> u64 {
        owner.require_auth();
        assert!(amount_in > 0, "zero amount");
        assert!(order_type <= 2, "bad order type");

        let contract = env.current_contract_address();
        TokenClient::new(&env, &token_in).transfer(
            &owner,
            &contract,
            &(amount_in as i128),
        );

        let id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap_or(1);
        env.storage().instance().set(&DataKey::NextId, &(id + 1));

        let order = Order {
            owner: owner.clone(),
            pool,
            token_in,
            zero_for_one,
            amount_in,
            min_amount_out,
            trigger_sqrt_price,
            order_type,
            expiry_ledger,
            status: STATUS_OPEN,
            created_at: env.ledger().timestamp(),
        };
        env.storage().instance().set(&DataKey::Order(id), &order);

        let mut open: Vec<u64> = env.storage().instance()
            .get(&DataKey::OpenIds)
            .unwrap_or(Vec::new(&env));
        open.push_back(id);
        env.storage().instance().set(&DataKey::OpenIds, &open);
        id
    }

    pub fn cancel_order(env: Env, owner: Address, order_id: u64) {
        owner.require_auth();
        let key = DataKey::Order(order_id);
        let mut order: Order = env.storage().instance().get(&key).expect("no order");
        assert!(order.owner == owner, "not owner");
        assert!(order.status == STATUS_OPEN, "not open");

        let contract = env.current_contract_address();
        TokenClient::new(&env, &order.token_in).transfer(
            &contract,
            &owner,
            &(order.amount_in as i128),
        );
        order.status = STATUS_CANCELLED;
        env.storage().instance().set(&key, &order);
        Self::_remove_open(&env, order_id);
    }

    /// Fill when trigger price is met. Callable by anyone (keeper).
    pub fn fill_order(env: Env, order_id: u64) -> bool {
        let key = DataKey::Order(order_id);
        let mut order: Order = env.storage().instance().get(&key).expect("no order");
        if order.status != STATUS_OPEN {
            return false;
        }

        let now = env.ledger().sequence();
        if order.expiry_ledger > 0 && now > order.expiry_ledger {
            let contract = env.current_contract_address();
            TokenClient::new(&env, &order.token_in).transfer(
                &contract,
                &order.owner,
                &(order.amount_in as i128),
            );
            order.status = STATUS_EXPIRED;
            env.storage().instance().set(&key, &order);
            Self::_remove_open(&env, order_id);
            return false;
        }

        let pool_client = PoolClient::new(&env, &order.pool);
        let current_sqrt = pool_client.sqrt_price();
        if !Self::_should_fill(&order, current_sqrt) {
            return false;
        }

        let contract = env.current_contract_address();
        let price_limit = if order.zero_for_one {
            order.trigger_sqrt_price.max(1)
        } else {
            order.trigger_sqrt_price
        };

        // Pool pulls token_in via transfer_from — grant allowance for this fill.
        let expiration = env.ledger().sequence() + 10_000;
        TokenClient::new(&env, &order.token_in).approve(
            &contract,
            &order.pool,
            &(order.amount_in as i128),
            &expiration,
        );

        let (d0, d1) = pool_client.swap(
            &contract,
            &order.zero_for_one,
            &(order.amount_in as i128),
            &price_limit,
        );

        let amount_out = if order.zero_for_one {
            (-d1).max(0) as u128
        } else {
            (-d0).max(0) as u128
        };
        assert!(amount_out >= order.min_amount_out, "insufficient output");

        let out_token = if order.zero_for_one {
            pool_client.token1()
        } else {
            pool_client.token0()
        };
        TokenClient::new(&env, &out_token).transfer(
            &contract,
            &order.owner,
            &(amount_out as i128),
        );

        order.status = STATUS_FILLED;
        env.storage().instance().set(&key, &order);
        Self::_remove_open(&env, order_id);
        true
    }

    pub fn get_order(env: Env, order_id: u64) -> Option<Order> {
        env.storage().instance().get(&DataKey::Order(order_id))
    }

    pub fn open_orders(env: Env) -> Vec<u64> {
        env.storage().instance()
            .get(&DataKey::OpenIds)
            .unwrap_or(Vec::new(&env))
    }

    fn _should_fill(order: &Order, current_sqrt: u128) -> bool {
        match order.order_type {
            0 => {
                if order.zero_for_one {
                    current_sqrt >= order.trigger_sqrt_price
                } else {
                    current_sqrt <= order.trigger_sqrt_price
                }
            }
            1 => order.zero_for_one && current_sqrt <= order.trigger_sqrt_price,
            2 => order.zero_for_one && current_sqrt >= order.trigger_sqrt_price,
            _ => false,
        }
    }

    fn _remove_open(env: &Env, order_id: u64) {
        let open: Vec<u64> = env.storage().instance()
            .get(&DataKey::OpenIds)
            .unwrap_or(Vec::new(env));
        let mut next = Vec::<u64>::new(env);
        for i in 0..open.len() {
            let id = open.get(i).unwrap();
            if id != order_id {
                next.push_back(id);
            }
        }
        env.storage().instance().set(&DataKey::OpenIds, &next);
    }
}
