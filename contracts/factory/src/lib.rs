#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short,
    Address, Bytes, BytesN, Env, Vec,
};

/// Fee tier: 5 = 0.05%, 30 = 0.3%, 100 = 1%
#[derive(Clone, Copy, PartialEq, Eq)]
#[contracttype]
pub enum FeeTier {
    Low,    // 0.05%
    Medium, // 0.3%
    High,   // 1.0%
}

#[derive(Clone)]
#[contracttype]
pub struct PoolKey {
    pub token_a: Address,
    pub token_b: Address,
    pub fee: FeeTier,
}

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    PoolWasm,
    Pool(PoolKey),
    AllPools,
}

#[derive(Clone)]
#[contracttype]
pub struct PoolInfo {
    pub address: Address,
    pub token_a: Address,
    pub token_b: Address,
    pub fee: FeeTier,
    pub fee_bps: u32,
}

#[contract]
pub struct Factory;

#[contractimpl]
impl Factory {
    pub fn initialize(env: Env, admin: Address, pool_wasm_hash: BytesN<32>) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::PoolWasm, &pool_wasm_hash);
        env.storage().instance().set(&DataKey::AllPools, &Vec::<PoolInfo>::new(&env));
    }

    pub fn create_pool(
        env: Env,
        token_a: Address,
        token_b: Address,
        fee: FeeTier,
        initial_sqrt_price: u128,
    ) -> Address {
        // Canonicalize token order
        let (t0, t1) = if token_a < token_b {
            (token_a.clone(), token_b.clone())
        } else {
            (token_b.clone(), token_a.clone())
        };

        let pool_key = PoolKey {
            token_a: t0.clone(),
            token_b: t1.clone(),
            fee,
        };

        if env.storage().persistent().has(&DataKey::Pool(pool_key.clone())) {
            panic!("pool already exists");
        }

        let fee_bps: u32 = match fee {
            FeeTier::Low => 5,
            FeeTier::Medium => 30,
            FeeTier::High => 100,
        };

        // Deploy pool contract — unique salt per (token0, token1, fee) so multiple pools can exist
        let pool_wasm_hash: BytesN<32> = env.storage().instance().get(&DataKey::PoolWasm).unwrap();
        let fee_byte: u8 = match fee {
            FeeTier::Low => 0,
            FeeTier::Medium => 1,
            FeeTier::High => 2,
        };
        let mut salt_preimage = Bytes::new(&env);
        salt_preimage.append(&t0.to_xdr(&env));
        salt_preimage.append(&t1.to_xdr(&env));
        salt_preimage.push(fee_byte);
        let salt = env.crypto().sha256(&salt_preimage);

        let pool_address = env
            .deployer()
            .with_current_contract(salt)
            .deploy_v2(pool_wasm_hash, (
                t0.clone(),
                t1.clone(),
                fee_bps,
                initial_sqrt_price,
                env.current_contract_address(),
            ));

        env.storage().persistent().set(&DataKey::Pool(pool_key.clone()), &pool_address);

        let pool_info = PoolInfo {
            address: pool_address.clone(),
            token_a: t0.clone(),
            token_b: t1.clone(),
            fee,
            fee_bps,
        };

        let mut all: Vec<PoolInfo> = env
            .storage()
            .instance()
            .get(&DataKey::AllPools)
            .unwrap_or(Vec::new(&env));
        all.push_back(pool_info);
        env.storage().instance().set(&DataKey::AllPools, &all);

        env.events().publish(
            (symbol_short!("pool_new"),),
            (t0, t1, fee_bps, pool_address.clone()),
        );

        pool_address
    }

    pub fn get_pool(env: Env, token_a: Address, token_b: Address, fee: FeeTier) -> Option<Address> {
        let (t0, t1) = if token_a < token_b {
            (token_a, token_b)
        } else {
            (token_b, token_a)
        };
        let key = PoolKey { token_a: t0, token_b: t1, fee };
        env.storage().persistent().get(&DataKey::Pool(key))
    }

    pub fn all_pools(env: Env) -> Vec<PoolInfo> {
        env.storage()
            .instance()
            .get(&DataKey::AllPools)
            .unwrap_or(Vec::new(&env))
    }

    pub fn pool_count(env: Env) -> u32 {
        let all: Vec<PoolInfo> = env
            .storage()
            .instance()
            .get(&DataKey::AllPools)
            .unwrap_or(Vec::new(&env));
        all.len()
    }

    pub fn admin(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Admin).unwrap()
    }
}

#[cfg(test)]
extern crate std;

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Address, BytesN, Env};

    fn setup(e: &Env) -> (Address, Address) {
        e.mock_all_auths();
        let admin = Address::generate(e);
        let contract_id = e.register_contract(None, Factory);
        let client = FactoryClient::new(e, &contract_id);
        let pool_wasm = BytesN::from_array(e, &[1u8; 32]);
        client.initialize(&admin, &pool_wasm);
        (contract_id, admin)
    }

    #[test]
    fn initialize_sets_admin() {
        let e = Env::default();
        let (contract_id, admin) = setup(&e);
        let client = FactoryClient::new(&e, &contract_id);
        assert_eq!(client.admin(), admin);
        assert_eq!(client.pool_count(), 0);
    }

    #[test]
    fn all_pools_starts_empty() {
        let e = Env::default();
        let (contract_id, _) = setup(&e);
        let client = FactoryClient::new(&e, &contract_id);
        assert_eq!(client.all_pools().len(), 0);
    }
}
