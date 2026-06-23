#![no_std]
//! StellarSwap Router: multi-hop swaps, add/remove liquidity, zap-in
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short,
    token::TokenClient,
    Address, Env, Vec,
};

// Pool interface — we call pool functions via env::invoke_contract
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

        fn mint(
            env: Env,
            to: Address,
            tick_lower: i32,
            tick_upper: i32,
            liquidity: u128,
        ) -> (u128, u128);

        fn burn(
            env: Env,
            from: Address,
            tick_lower: i32,
            tick_upper: i32,
            liquidity: u128,
        ) -> (u128, u128);

        fn collect(
            env: Env,
            from: Address,
            tick_lower: i32,
            tick_upper: i32,
            max0: u128,
            max1: u128,
        ) -> (u128, u128);

        fn token0(env: Env) -> Address;
        fn token1(env: Env) -> Address;
        fn sqrt_price(env: Env) -> u128;
        fn liquidity(env: Env) -> u128;
        fn fee_bps(env: Env) -> u32;
    }
}

// Factory interface
mod factory_interface {
    use soroban_sdk::{contractclient, Address, Env};
    use crate::FeeTier;

    #[contractclient(name = "FactoryClient")]
    pub trait FactoryTrait {
        fn get_pool(env: Env, token_a: Address, token_b: Address, fee: FeeTier) -> Option<Address>;
    }
}

use pool_interface::PoolClient;
use factory_interface::FactoryClient;

#[derive(Clone, Copy, PartialEq, Eq)]
#[contracttype]
pub enum FeeTier {
    Low,
    Medium,
    High,
}

#[derive(Clone)]
#[contracttype]
pub struct SwapParams {
    pub token_in: Address,
    pub token_out: Address,
    pub fee: FeeTier,
    pub amount_in: i128,
    pub min_amount_out: i128,
    pub recipient: Address,
    pub deadline: u64,
}

#[derive(Clone)]
#[contracttype]
pub struct MultiHopParams {
    pub path: Vec<Address>,   // [tokenA, tokenB, tokenC] — each consecutive pair is a swap
    pub fees: Vec<FeeTier>,   // [feeAB, feeBC]
    pub amount_in: i128,
    pub min_amount_out: i128,
    pub recipient: Address,
    pub deadline: u64,
}

#[derive(Clone)]
#[contracttype]
pub struct AddLiquidityParams {
    pub token0: Address,
    pub token1: Address,
    pub fee: FeeTier,
    pub tick_lower: i32,
    pub tick_upper: i32,
    pub amount0_desired: u128,
    pub amount1_desired: u128,
    pub amount0_min: u128,
    pub amount1_min: u128,
    pub recipient: Address,
    pub deadline: u64,
}

#[derive(Clone)]
#[contracttype]
pub struct RemoveLiquidityParams {
    pub pool: Address,
    pub tick_lower: i32,
    pub tick_upper: i32,
    pub liquidity: u128,
    pub amount0_min: u128,
    pub amount1_min: u128,
    pub recipient: Address,
    pub deadline: u64,
}

#[derive(Clone)]
#[contracttype]
pub struct ZapInParams {
    pub token_in: Address,
    pub token_other: Address,
    pub fee: FeeTier,
    pub tick_lower: i32,
    pub tick_upper: i32,
    pub amount_in: u128,
    pub min_liquidity: u128,
    pub recipient: Address,
    pub deadline: u64,
}

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Factory,
    Admin,
}

#[contract]
pub struct Router;

#[contractimpl]
impl Router {
    pub fn initialize(env: Env, factory: Address, admin: Address) {
        if env.storage().instance().has(&DataKey::Factory) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::Factory, &factory);
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    /// Single-hop exact-input swap
    pub fn swap_exact_input(env: Env, params: SwapParams) -> i128 {
        Self::check_deadline(&env, params.deadline);
        params.recipient.require_auth();

        let factory: Address = env.storage().instance().get(&DataKey::Factory).unwrap();
        let pool_opt = FactoryClient::new(&env, &factory).get_pool(
            &params.token_in,
            &params.token_out,
            &params.fee,
        );
        let pool = pool_opt.expect("pool not found");
        let pool_client = PoolClient::new(&env, &pool);

        let token0 = pool_client.token0();
        let zero_for_one = params.token_in == token0;

        let sqrt_price = pool_client.sqrt_price();
        let price_limit = if zero_for_one {
            sqrt_price / 2  // minimum price limit
        } else {
            sqrt_price * 2  // maximum price limit
        };

        let (delta0, delta1) = pool_client.swap(
            &params.recipient,
            &zero_for_one,
            &params.amount_in,
            &price_limit,
        );

        let amount_out = if zero_for_one {
            (-delta1).max(0)
        } else {
            (-delta0).max(0)
        };
        assert!(amount_out >= params.min_amount_out, "insufficient output");
        amount_out
    }

    /// Multi-hop exact-input swap
    pub fn swap_multi_hop(env: Env, params: MultiHopParams) -> i128 {
        Self::check_deadline(&env, params.deadline);
        params.recipient.require_auth();

        let factory: Address = env.storage().instance().get(&DataKey::Factory).unwrap();
        let mut amount_out = params.amount_in;

        for i in 0..(params.path.len() - 1) {
            let token_in = params.path.get(i).unwrap();
            let token_out = params.path.get(i + 1).unwrap();
            let fee = params.fees.get(i).unwrap();

            let pool_opt = FactoryClient::new(&env, &factory).get_pool(
                &token_in,
                &token_out,
                &fee,
            );
            let pool = pool_opt.expect("pool not found in path");
            let pool_client = PoolClient::new(&env, &pool);

            let token0 = pool_client.token0();
            let zero_for_one = token_in == token0;
            let sqrt_price = pool_client.sqrt_price();
            let price_limit = if zero_for_one {
                sqrt_price / 2
            } else {
                sqrt_price * 2
            };

            let recipient_for_hop = if i == params.path.len() - 2 {
                params.recipient.clone()
            } else {
                // For intermediate hops, use pool as recipient (token flows through)
                pool
            };

            let (delta0, delta1) = pool_client.swap(
                &recipient_for_hop,
                &zero_for_one,
                &amount_out,
                &price_limit,
            );

            amount_out = if zero_for_one {
                (-delta1).max(0)
            } else {
                (-delta0).max(0)
            };
        }

        assert!(amount_out >= params.min_amount_out, "insufficient output");
        amount_out
    }

    /// Add concentrated liquidity to a pool
    pub fn add_liquidity(env: Env, params: AddLiquidityParams) -> (u128, u128, u128) {
        Self::check_deadline(&env, params.deadline);
        params.recipient.require_auth();

        let factory: Address = env.storage().instance().get(&DataKey::Factory).unwrap();
        let pool_opt = FactoryClient::new(&env, &factory).get_pool(
            &params.token0,
            &params.token1,
            &params.fee,
        );
        let pool = pool_opt.expect("pool not found");
        let pool_client = PoolClient::new(&env, &pool);

        // Compute liquidity from desired amounts
        let sqrt_pa = crate::tick_to_sqrt_q32(params.tick_lower);
        let sqrt_pb = crate::tick_to_sqrt_q32(params.tick_upper);
        let sqrt_price = pool_client.sqrt_price();

        let liquidity = compute_liquidity(
            sqrt_price,
            sqrt_pa,
            sqrt_pb,
            params.amount0_desired,
            params.amount1_desired,
        );

        let (amount0, amount1) = pool_client.mint(
            &params.recipient,
            &params.tick_lower,
            &params.tick_upper,
            &liquidity,
        );

        assert!(amount0 >= params.amount0_min, "amount0 below minimum");
        assert!(amount1 >= params.amount1_min, "amount1 below minimum");

        env.events().publish(
            (symbol_short!("add_liq"),),
            (params.recipient, liquidity, amount0, amount1),
        );

        (liquidity, amount0, amount1)
    }

    /// Remove concentrated liquidity and collect tokens in one call
    pub fn remove_liquidity(env: Env, params: RemoveLiquidityParams) -> (u128, u128) {
        Self::check_deadline(&env, params.deadline);
        params.recipient.require_auth();

        let pool_client = PoolClient::new(&env, &params.pool);

        // Burn the position
        let (burn0, burn1) = pool_client.burn(
            &params.recipient,
            &params.tick_lower,
            &params.tick_upper,
            &params.liquidity,
        );

        // Collect all owed tokens
        let (collect0, collect1) = pool_client.collect(
            &params.recipient,
            &params.tick_lower,
            &params.tick_upper,
            &u128::MAX,
            &u128::MAX,
        );

        let total0 = burn0.max(collect0);
        let total1 = burn1.max(collect1);

        assert!(total0 >= params.amount0_min, "amount0 below minimum");
        assert!(total1 >= params.amount1_min, "amount1 below minimum");

        env.events().publish(
            (symbol_short!("rm_liq"),),
            (params.recipient, params.liquidity, total0, total1),
        );

        (total0, total1)
    }

    /// Zap in: single-asset deposit (swap ~half, then add liquidity)
    pub fn zap_in(env: Env, params: ZapInParams) -> u128 {
        Self::check_deadline(&env, params.deadline);
        params.recipient.require_auth();

        let factory: Address = env.storage().instance().get(&DataKey::Factory).unwrap();
        let pool_opt = FactoryClient::new(&env, &factory).get_pool(
            &params.token_in,
            &params.token_other,
            &params.fee,
        );
        let pool = pool_opt.expect("pool not found");
        let pool_client = PoolClient::new(&env, &pool);

        let token0 = pool_client.token0();
        let zero_for_one = params.token_in == token0;

        // Swap half of amount_in to get the other token
        let swap_amount = params.amount_in / 2;
        let sqrt_price = pool_client.sqrt_price();
        let price_limit = if zero_for_one { sqrt_price / 2 } else { sqrt_price * 2 };

        let (delta0, delta1) = pool_client.swap(
            &params.recipient,
            &zero_for_one,
            &(swap_amount as i128),
            &price_limit,
        );

        let (amount0, amount1) = if zero_for_one {
            (params.amount_in - swap_amount, (-delta1) as u128)
        } else {
            ((-delta0) as u128, params.amount_in - swap_amount)
        };

        let sqrt_pa = crate::tick_to_sqrt_q32(params.tick_lower);
        let sqrt_pb = crate::tick_to_sqrt_q32(params.tick_upper);
        let new_sqrt_price = pool_client.sqrt_price();
        let liquidity = compute_liquidity(new_sqrt_price, sqrt_pa, sqrt_pb, amount0, amount1);
        assert!(liquidity >= params.min_liquidity, "insufficient liquidity");

        pool_client.mint(
            &params.recipient,
            &params.tick_lower,
            &params.tick_upper,
            &liquidity,
        );

        env.events().publish(
            (symbol_short!("zap_in"),),
            (params.recipient, params.amount_in, liquidity),
        );

        liquidity
    }

    fn check_deadline(env: &Env, deadline: u64) {
        assert!(env.ledger().timestamp() <= deadline, "expired deadline");
    }

    pub fn factory(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Factory).unwrap()
    }
}

/// Inverse of pool `get_amount0_delta`: L = amount0 * (lo*hi/Q32) / (hi-lo)
fn liquidity_from_amount0(sqrt_a: u128, sqrt_b: u128, amount0: u128) -> u128 {
    const Q32: u128 = 1u128 << 32;
    let (lo, hi) = if sqrt_a <= sqrt_b {
        (sqrt_a, sqrt_b)
    } else {
        (sqrt_b, sqrt_a)
    };
    if lo == 0 || hi == 0 || amount0 == 0 {
        return 0;
    }
    let delta = hi - lo;
    let denom = lo.saturating_mul(hi) / Q32;
    if denom == 0 || delta == 0 {
        return 0;
    }
    amount0.saturating_mul(denom) / delta
}

/// Inverse of pool `get_amount1_delta`: L = amount1 * Q32 / (hi-lo)
fn liquidity_from_amount1(sqrt_a: u128, sqrt_b: u128, amount1: u128) -> u128 {
    const Q32: u128 = 1u128 << 32;
    let (lo, hi) = if sqrt_a <= sqrt_b {
        (sqrt_a, sqrt_b)
    } else {
        (sqrt_b, sqrt_a)
    };
    if amount1 == 0 {
        return 0;
    }
    let delta = hi - lo;
    if delta == 0 {
        return 0;
    }
    amount1.saturating_mul(Q32) / delta
}

/// Compute liquidity from token amounts and price range (matches pool mint math).
fn compute_liquidity(
    sqrt_price: u128,
    sqrt_pa: u128,
    sqrt_pb: u128,
    amount0: u128,
    amount1: u128,
) -> u128 {
    if sqrt_pb <= sqrt_pa {
        return 0;
    }
    if sqrt_price <= sqrt_pa {
        liquidity_from_amount0(sqrt_pa, sqrt_pb, amount0)
    } else if sqrt_price >= sqrt_pb {
        liquidity_from_amount1(sqrt_pa, sqrt_pb, amount1)
    } else {
        liquidity_from_amount0(sqrt_price, sqrt_pb, amount0)
            .min(liquidity_from_amount1(sqrt_pa, sqrt_price, amount1))
    }
}

/// Re-export tick_to_sqrt_q32 for internal use
fn tick_to_sqrt_q32(tick: i32) -> u128 {
    const Q32: u128 = 1u128 << 32;
    const SQRT_RATIOS: [u64; 20] = [
        4_294_967_510, 4_295_182_081, 4_295_611_251, 4_296_469_654,
        4_298_186_610, 4_301_624_122, 4_308_510_505, 4_322_345_397,
        4_350_303_842, 4_407_276_366, 4_525_352_677, 4_775_269_659,
        5_326_259_950, 6_634_987_051, 10_285_119_115, 24_733_587_905,
        143_126_956_685, 4_810_775_551_248_u64, 545_383_428_507_040_u64,
        7_047_666_939_293_130_u64,
    ];
    let abs_tick = if tick < 0 { (-tick) as u64 } else { tick as u64 };
    let mut result: u128 = Q32;
    for i in 0..19u64 {
        if abs_tick & (1u64 << i) != 0 {
            result = result.saturating_mul(SQRT_RATIOS[i as usize] as u128) / Q32;
        }
    }
    if tick < 0 {
        result = Q32.saturating_mul(Q32) / result;
    }
    result
}
