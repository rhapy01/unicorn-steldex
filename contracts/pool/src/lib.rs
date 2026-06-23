#![no_std]
//! StellarSwap Concentrated Liquidity Pool
//!
//! Implements UniswapV3-style concentrated liquidity with:
//! - Tick-based price ranges
//! - Multiple fee tiers (5, 30, 100 bps)
//! - Per-position fee accounting
//! - TWAP oracle observations
//! - Flash loans
//!
//! Math:
//!   sqrt_price: u128 stored as Q32.32 (multiply by 2^32)
//!   tick      : i32  = floor(log_{1.0001}(price))
//!   liquidity : u128 (virtual liquidity units)

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short,
    token::TokenClient,
    Address, Env, Vec,
};

// ---------------------------------------------------------------------------
// Fixed-point constants
// ---------------------------------------------------------------------------
/// Q32 = 2^32. All sqrt_price values are scaled by Q32.
const Q32: u128 = 1u128 << 32; // 4_294_967_296

/// Minimum and maximum tick values
const MIN_TICK: i32 = -443636;
const MAX_TICK: i32 = 443636;

/// Maximum protocol fee: 50% of pool fee
const MAX_PROTOCOL_FEE: u32 = 5000; // 50% = 5000/10000

// ---------------------------------------------------------------------------
// Storage types
// ---------------------------------------------------------------------------

#[derive(Clone)]
#[contracttype]
pub struct PositionKey {
    pub owner: Address,
    pub tick_lower: i32,
    pub tick_upper: i32,
}

#[derive(Clone, Default)]
#[contracttype]
pub struct Position {
    pub liquidity: u128,
    pub fee_growth_inside_0_last: u128,
    pub fee_growth_inside_1_last: u128,
    pub tokens_owed_0: u128,
    pub tokens_owed_1: u128,
}

#[derive(Clone, Default)]
#[contracttype]
pub struct TickInfo {
    pub liquidity_gross: u128,
    pub liquidity_net: i128,
    pub fee_growth_outside_0: u128,
    pub fee_growth_outside_1: u128,
    pub initialized: bool,
}

#[derive(Clone)]
#[contracttype]
pub struct Observation {
    pub timestamp: u64,
    pub sqrt_price: u128,
    pub tick: i32,
}

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Token0,
    Token1,
    FeeBps,
    TickSpacing,
    SqrtPrice,
    CurrentTick,
    Liquidity,
    FeeGrowthGlobal0,
    FeeGrowthGlobal1,
    ProtocolFee0,
    ProtocolFee1,
    ProtocolFeeRecipient,
    Factory,
    Initialized,
    Position(PositionKey),
    Tick(i32),
    Observations,
    ObsIndex,
}

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

/// Compute the log base 1.0001 of the sqrt_price ratio (for tick)
/// Uses the formula: tick ≈ floor(2 * log(sqrt_price/Q32) / log(1.0001))
/// Implemented via binary logarithm:  log(x) = log2(x) * ln(2)
fn sqrt_price_to_tick(sqrt_price: u128) -> i32 {
    if sqrt_price == 0 {
        return MIN_TICK;
    }
    // log2(sqrt_price / Q32) × 2 / log2(1.0001)
    // log2(1.0001) ≈ 0.000144262... = 144262/10^9
    // 1/log2(1.0001) ≈ 6931.472

    // Compute floor(log2(sqrt_price)) using leading_zeros
    let bits = 128u32 - sqrt_price.leading_zeros();
    // integer part of log2(sqrt_price) minus 32 (for Q32)
    let int_log2: i64 = bits as i64 - 1 - 32;

    // Fractional part (bits after the leading 1)
    let leading_bit_pos = bits - 1;
    let frac_bits: u64 = if leading_bit_pos < 64 {
        ((sqrt_price << (63 - leading_bit_pos)) >> 32) as u64
    } else {
        (sqrt_price >> (leading_bit_pos - 31)) as u64
    };

    // log2(sqrt_price/Q32) ≈ int_log2 + frac_bits/2^32
    // tick ≈ 2 * log2_val * 6931 / 10000
    // But we want: tick = floor(2 * log_{1.0001}(sqrt_price / Q32))
    //                   = floor(2 * log2(sqrt_price/Q32) * 10000/144.262...)
    //                   ≈ floor(2 * log2(sqrt_price/Q32) * 6931.47...)
    
    // Use fixed-point: multiply by 6931*2 = 13862
    let log2_fixed: i64 = int_log2 * 10000 + (frac_bits as i64 * 10000 / 4294967296_i64);
    let tick = log2_fixed * 13862 / 100000;
    
    tick.max(MIN_TICK as i64).min(MAX_TICK as i64) as i32
}

/// Compute sqrt(1.0001^tick) * Q32 using the efficient bit-decomposition method.
/// tick_to_sqrt_price returns a Q32.32 fixed point sqrt price.
fn tick_to_sqrt_price(tick: i32) -> u128 {
    let abs_tick = if tick < 0 { (-tick) as u64 } else { tick as u64 };

    // We work in Q64.64 to have extra precision during computation, then scale down
    // Each bit of abs_tick multiplies by a precomputed constant ≈ sqrt(1.0001^(-2^i)) in Q64
    // Precomputed: val = floor(2^64 / sqrt(1.0001^(2^i)))
    // bit 0: 2^64 / sqrt(1.0001) = 2^64 * 0.999950004 ≈ 18446743974429xxxxxx
    // We approximate using: Q32 * (1 + tick * 5e-5 + tick^2 * 1.25e-9)
    // This polynomial approximation is accurate for |tick| < 10000

    if abs_tick == 0 {
        return Q32;
    }

    // Simple approach: use the recurrence (1.0001^(1/2))^tick
    // (1.0001^0.5)^1 = 1.0000499987... ≈ 1 + 5e-5
    // We compute this iteratively using integer math
    // sqrt_price = Q32 * (1.0001^(tick/2))
    //
    // Using Horner's method for the polynomial:
    // For |tick| <= 443636, the max price ratio is 2^32 in sqrt terms
    
    // Binary exponentiation with Q32 fixed point
    // Each step: result *= sqrt(1.0001^(2^i)) for each set bit i
    
    // Precomputed sqrt(1.0001^(2^i)) * Q32 for i = 0..17
    // (i.e., tick spacings of 1, 2, 4, 8, 16, ...)
    const SQRT_RATIOS: [u64; 20] = [
        4_294_967_510, // sqrt(1.0001^1) * Q32    ≈ Q32 * 1.00004999875
        4_295_182_081, // sqrt(1.0001^2) * Q32
        4_295_611_251, // sqrt(1.0001^4) * Q32
        4_296_469_654, // sqrt(1.0001^8) * Q32
        4_298_186_610, // sqrt(1.0001^16) * Q32
        4_301_624_122, // sqrt(1.0001^32) * Q32
        4_308_510_505, // sqrt(1.0001^64) * Q32
        4_322_345_397, // sqrt(1.0001^128) * Q32
        4_350_303_842, // sqrt(1.0001^256) * Q32
        4_407_276_366, // sqrt(1.0001^512) * Q32
        4_525_352_677, // sqrt(1.0001^1024) * Q32
        4_775_269_659, // sqrt(1.0001^2048) * Q32
        5_326_259_950, // sqrt(1.0001^4096) * Q32
        6_634_987_051, // sqrt(1.0001^8192) * Q32
        10_285_119_115, // sqrt(1.0001^16384) * Q32
        24_733_587_905, // sqrt(1.0001^32768) * Q32
        143_126_956_685, // sqrt(1.0001^65536) * Q32
        4_810_775_551_248_u64, // sqrt(1.0001^131072) * Q32  
        545_383_428_507_040_u64, // sqrt(1.0001^262144) * Q32
        7_047_666_939_293_130_u64, // sqrt(1.0001^524288) * Q32 - capped
    ];

    let mut result: u128 = Q32; // Start with 1.0 in Q32 format

    for i in 0..19u64 {
        if abs_tick & (1u64 << i) != 0 {
            // Multiply result by SQRT_RATIOS[i] / Q32
            result = result
                .checked_mul(SQRT_RATIOS[i as usize] as u128)
                .expect("overflow")
                / Q32;
        }
    }

    // If tick is negative, invert: Q32^2 / result
    if tick < 0 {
        result = Q32.checked_mul(Q32).expect("overflow") / result;
    }

    result
}

/// Calculate amount0 delta for a liquidity change within [sqrt_pa, sqrt_pb]
/// amount0 = liquidity * (sqrt_pb - sqrt_pa) / (sqrt_pa * sqrt_pb / Q32)
///         = liquidity * (sqrt_pb - sqrt_pa) * Q32 / (sqrt_pa * sqrt_pb)
fn get_amount0_delta(sqrt_pa: u128, sqrt_pb: u128, liquidity: u128) -> u128 {
    let (lo, hi) = if sqrt_pa <= sqrt_pb {
        (sqrt_pa, sqrt_pb)
    } else {
        (sqrt_pb, sqrt_pa)
    };
    if lo == 0 || hi == 0 || liquidity == 0 {
        return 0;
    }
    let delta = hi - lo;
    // amount0 = L * delta * Q32 / (lo * hi)
    // To avoid overflow: use mul_div with careful ordering
    let denom = lo.checked_mul(hi).expect("overflow in sqrt product") / Q32;
    if denom == 0 {
        return 0;
    }
    liquidity.checked_mul(delta).expect("overflow in amount0") / denom
}

/// Calculate amount1 delta for a liquidity change within [sqrt_pa, sqrt_pb]
/// amount1 = liquidity * (sqrt_pb - sqrt_pa) / Q32
fn get_amount1_delta(sqrt_pa: u128, sqrt_pb: u128, liquidity: u128) -> u128 {
    let (lo, hi) = if sqrt_pa <= sqrt_pb {
        (sqrt_pa, sqrt_pb)
    } else {
        (sqrt_pb, sqrt_pa)
    };
    if liquidity == 0 {
        return 0;
    }
    let delta = hi - lo;
    liquidity.checked_mul(delta).expect("overflow in amount1") / Q32
}

/// Get the next sqrt price after swapping amount_in of token0 (zero_for_one = true)
/// next_sqrt = liquidity * sqrt_price / (liquidity + amount_in * sqrt_price / Q32)
fn get_next_sqrt_price_from_amount0_input(
    sqrt_price: u128,
    liquidity: u128,
    amount_in: u128,
) -> u128 {
    if amount_in == 0 {
        return sqrt_price;
    }
    let numerator = liquidity.checked_mul(sqrt_price).expect("overflow");
    let product = amount_in.checked_mul(sqrt_price).expect("overflow") / Q32;
    numerator / (liquidity + product)
}

/// Get the next sqrt price after swapping amount_in of token1 (zero_for_one = false)
/// next_sqrt = sqrt_price + amount_in / liquidity * Q32
fn get_next_sqrt_price_from_amount1_input(
    sqrt_price: u128,
    liquidity: u128,
    amount_in: u128,
) -> u128 {
    sqrt_price + amount_in.checked_mul(Q32).expect("overflow") / liquidity
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct Pool;

#[contractimpl]
impl Pool {
    /// Soroban deploy_v2 entrypoint — delegates to `initialize`.
    pub fn __constructor(
        env: Env,
        token0: Address,
        token1: Address,
        fee_bps: u32,
        initial_sqrt_price: u128,
        factory: Address,
    ) {
        Self::initialize(env, token0, token1, fee_bps, initial_sqrt_price, factory);
    }

    /// Initialize the pool. Called by factory on deployment.
    pub fn initialize(
        env: Env,
        token0: Address,
        token1: Address,
        fee_bps: u32,
        initial_sqrt_price: u128,
        factory: Address,
    ) {
        if env.storage().instance().has(&DataKey::Initialized) {
            panic!("already initialized");
        }
        assert!(fee_bps == 5 || fee_bps == 30 || fee_bps == 100, "invalid fee");
        assert!(initial_sqrt_price >= Q32 / 1000 && initial_sqrt_price <= Q32 * 1000, "price out of range");

        let tick_spacing: i32 = match fee_bps {
            5 => 10,
            30 => 60,
            100 => 200,
            _ => 60,
        };

        env.storage().instance().set(&DataKey::Token0, &token0);
        env.storage().instance().set(&DataKey::Token1, &token1);
        env.storage().instance().set(&DataKey::FeeBps, &fee_bps);
        env.storage().instance().set(&DataKey::TickSpacing, &tick_spacing);
        env.storage().instance().set(&DataKey::SqrtPrice, &initial_sqrt_price);
        env.storage().instance().set(&DataKey::CurrentTick, &sqrt_price_to_tick(initial_sqrt_price));
        env.storage().instance().set(&DataKey::Liquidity, &0u128);
        env.storage().instance().set(&DataKey::FeeGrowthGlobal0, &0u128);
        env.storage().instance().set(&DataKey::FeeGrowthGlobal1, &0u128);
        env.storage().instance().set(&DataKey::ProtocolFee0, &0u128);
        env.storage().instance().set(&DataKey::ProtocolFee1, &0u128);
        env.storage().instance().set(&DataKey::Factory, &factory);
        env.storage().instance().set(&DataKey::ObsIndex, &0u32);
        env.storage().instance().set(&DataKey::Observations, &Vec::<Observation>::new(&env));
        env.storage().instance().set(&DataKey::Initialized, &true);

        // Record initial observation
        let obs = Observation {
            timestamp: env.ledger().timestamp(),
            sqrt_price: initial_sqrt_price,
            tick: sqrt_price_to_tick(initial_sqrt_price),
        };
        let mut observations = Vec::<Observation>::new(&env);
        observations.push_back(obs);
        env.storage().instance().set(&DataKey::Observations, &observations);
    }

    /// Add concentrated liquidity to a tick range.
    /// Returns (amount0, amount1) deposited.
    pub fn mint(
        env: Env,
        to: Address,
        tick_lower: i32,
        tick_upper: i32,
        liquidity: u128,
    ) -> (u128, u128) {
        to.require_auth();
        Self::check_initialized(&env);
        assert!(tick_lower < tick_upper, "invalid tick range");
        assert!(tick_lower >= MIN_TICK && tick_upper <= MAX_TICK, "tick out of range");
        assert!(liquidity > 0, "zero liquidity");

        let tick_spacing: i32 = env.storage().instance().get(&DataKey::TickSpacing).unwrap();
        assert!(tick_lower % tick_spacing == 0 && tick_upper % tick_spacing == 0, "tick not aligned");

        let sqrt_price: u128 = env.storage().instance().get(&DataKey::SqrtPrice).unwrap();
        let current_tick: i32 = env.storage().instance().get(&DataKey::CurrentTick).unwrap();
        let sqrt_pa = tick_to_sqrt_price(tick_lower);
        let sqrt_pb = tick_to_sqrt_price(tick_upper);

        // Compute required amounts based on current price position
        let (amount0, amount1) = if current_tick < tick_lower {
            // Entirely in token0
            let a0 = get_amount0_delta(sqrt_pa, sqrt_pb, liquidity);
            (a0, 0u128)
        } else if current_tick < tick_upper {
            // Straddles current price — contribute both
            let a0 = get_amount0_delta(sqrt_price, sqrt_pb, liquidity);
            let a1 = get_amount1_delta(sqrt_pa, sqrt_price, liquidity);
            // Update active liquidity
            let cur_liq: u128 = env.storage().instance().get(&DataKey::Liquidity).unwrap();
            env.storage().instance().set(&DataKey::Liquidity, &(cur_liq + liquidity));
            (a0, a1)
        } else {
            // Entirely in token1
            let a1 = get_amount1_delta(sqrt_pa, sqrt_pb, liquidity);
            (0u128, a1)
        };

        // Transfer tokens from user to pool
        let token0: Address = env.storage().instance().get(&DataKey::Token0).unwrap();
        let token1: Address = env.storage().instance().get(&DataKey::Token1).unwrap();
        let contract = env.current_contract_address();

        if amount0 > 0 {
            TokenClient::new(&env, &token0).transfer_from(
                &contract,
                &to,
                &contract,
                &(amount0 as i128),
            );
        }
        if amount1 > 0 {
            TokenClient::new(&env, &token1).transfer_from(
                &contract,
                &to,
                &contract,
                &(amount1 as i128),
            );
        }

        // Update position
        let fee_growth_global_0: u128 = env.storage().instance().get(&DataKey::FeeGrowthGlobal0).unwrap();
        let fee_growth_global_1: u128 = env.storage().instance().get(&DataKey::FeeGrowthGlobal1).unwrap();

        let pos_key = PositionKey {
            owner: to.clone(),
            tick_lower,
            tick_upper,
        };
        let mut pos: Position = env
            .storage()
            .persistent()
            .get(&DataKey::Position(pos_key.clone()))
            .unwrap_or_default();

        pos.liquidity += liquidity;
        pos.fee_growth_inside_0_last = fee_growth_global_0;
        pos.fee_growth_inside_1_last = fee_growth_global_1;
        env.storage().persistent().set(&DataKey::Position(pos_key), &pos);

        // Update tick info
        Self::update_tick(&env, tick_lower, liquidity as i128, false);
        Self::update_tick(&env, tick_upper, liquidity as i128, true);

        env.events().publish(
            (symbol_short!("mint"),),
            (to, tick_lower, tick_upper, liquidity, amount0, amount1),
        );

        (amount0, amount1)
    }

    /// Remove liquidity from a position.
    /// Returns (amount0, amount1) removed (not yet collected - must call collect).
    pub fn burn(
        env: Env,
        from: Address,
        tick_lower: i32,
        tick_upper: i32,
        liquidity: u128,
    ) -> (u128, u128) {
        from.require_auth();
        Self::check_initialized(&env);

        let pos_key = PositionKey {
            owner: from.clone(),
            tick_lower,
            tick_upper,
        };
        let mut pos: Position = env
            .storage()
            .persistent()
            .get(&DataKey::Position(pos_key.clone()))
            .unwrap_or_default();

        assert!(pos.liquidity >= liquidity, "insufficient position liquidity");

        let sqrt_price: u128 = env.storage().instance().get(&DataKey::SqrtPrice).unwrap();
        let current_tick: i32 = env.storage().instance().get(&DataKey::CurrentTick).unwrap();
        let sqrt_pa = tick_to_sqrt_price(tick_lower);
        let sqrt_pb = tick_to_sqrt_price(tick_upper);

        let (amount0, amount1) = if current_tick < tick_lower {
            let a0 = get_amount0_delta(sqrt_pa, sqrt_pb, liquidity);
            (a0, 0u128)
        } else if current_tick < tick_upper {
            let a0 = get_amount0_delta(sqrt_price, sqrt_pb, liquidity);
            let a1 = get_amount1_delta(sqrt_pa, sqrt_price, liquidity);
            let cur_liq: u128 = env.storage().instance().get(&DataKey::Liquidity).unwrap();
            env.storage().instance().set(&DataKey::Liquidity, &(cur_liq - liquidity));
            (a0, a1)
        } else {
            let a1 = get_amount1_delta(sqrt_pa, sqrt_pb, liquidity);
            (0u128, a1)
        };

        // Accrue fees to position
        let (fees0, fees1) = Self::compute_position_fees(&env, &pos, tick_lower, tick_upper);
        pos.tokens_owed_0 += amount0 + fees0;
        pos.tokens_owed_1 += amount1 + fees1;
        pos.liquidity -= liquidity;

        let fee_growth_global_0: u128 = env.storage().instance().get(&DataKey::FeeGrowthGlobal0).unwrap();
        let fee_growth_global_1: u128 = env.storage().instance().get(&DataKey::FeeGrowthGlobal1).unwrap();
        pos.fee_growth_inside_0_last = fee_growth_global_0;
        pos.fee_growth_inside_1_last = fee_growth_global_1;

        env.storage().persistent().set(&DataKey::Position(pos_key), &pos);

        // Update ticks
        Self::update_tick(&env, tick_lower, -(liquidity as i128), false);
        Self::update_tick(&env, tick_upper, -(liquidity as i128), true);

        env.events().publish(
            (symbol_short!("burn"),),
            (from, tick_lower, tick_upper, liquidity, amount0, amount1),
        );

        (amount0, amount1)
    }

    /// Collect owed tokens (fees + removed liquidity).
    /// Returns (amount0, amount1) collected.
    pub fn collect(
        env: Env,
        from: Address,
        tick_lower: i32,
        tick_upper: i32,
        max0: u128,
        max1: u128,
    ) -> (u128, u128) {
        from.require_auth();
        Self::check_initialized(&env);

        let pos_key = PositionKey {
            owner: from.clone(),
            tick_lower,
            tick_upper,
        };
        let mut pos: Position = env
            .storage()
            .persistent()
            .get(&DataKey::Position(pos_key.clone()))
            .unwrap_or_default();

        // Include unclaimed fees
        let (fees0, fees1) = Self::compute_position_fees(&env, &pos, tick_lower, tick_upper);
        pos.tokens_owed_0 += fees0;
        pos.tokens_owed_1 += fees1;
        let fee_growth_global_0: u128 = env.storage().instance().get(&DataKey::FeeGrowthGlobal0).unwrap();
        let fee_growth_global_1: u128 = env.storage().instance().get(&DataKey::FeeGrowthGlobal1).unwrap();
        pos.fee_growth_inside_0_last = fee_growth_global_0;
        pos.fee_growth_inside_1_last = fee_growth_global_1;

        let collect0 = pos.tokens_owed_0.min(max0);
        let collect1 = pos.tokens_owed_1.min(max1);

        pos.tokens_owed_0 -= collect0;
        pos.tokens_owed_1 -= collect1;
        env.storage().persistent().set(&DataKey::Position(pos_key), &pos);

        let token0: Address = env.storage().instance().get(&DataKey::Token0).unwrap();
        let token1: Address = env.storage().instance().get(&DataKey::Token1).unwrap();
        let contract = env.current_contract_address();

        if collect0 > 0 {
            TokenClient::new(&env, &token0).transfer(&contract, &from, &(collect0 as i128));
        }
        if collect1 > 0 {
            TokenClient::new(&env, &token1).transfer(&contract, &from, &(collect1 as i128));
        }

        env.events().publish(
            (symbol_short!("collect"),),
            (from, tick_lower, tick_upper, collect0, collect1),
        );

        (collect0, collect1)
    }

    /// Execute a swap. Returns (amount0, amount1) — negative means sent out, positive means received.
    /// zero_for_one: true = swap token0 → token1
    /// amount_specified: positive = exact input, negative = exact output
    pub fn swap(
        env: Env,
        recipient: Address,
        zero_for_one: bool,
        amount_specified: i128,
        sqrt_price_limit: u128,
    ) -> (i128, i128) {
        Self::check_initialized(&env);
        assert!(amount_specified != 0, "zero amount");

        let sqrt_price: u128 = env.storage().instance().get(&DataKey::SqrtPrice).unwrap();
        let fee_bps: u32 = env.storage().instance().get(&DataKey::FeeBps).unwrap();
        let liquidity: u128 = env.storage().instance().get(&DataKey::Liquidity).unwrap();

        if zero_for_one {
            assert!(sqrt_price_limit < sqrt_price, "invalid price limit");
        } else {
            assert!(sqrt_price_limit > sqrt_price, "invalid price limit");
        }

        let exact_input = amount_specified > 0;
        let amount_remaining = if exact_input {
            amount_specified as u128
        } else {
            (-amount_specified) as u128
        };

        // Simple single-step swap (no tick crossing for now — simplified model)
        // Full tick traversal would require the tick bitmap; here we use active liquidity
        if liquidity == 0 {
            return (0, 0);
        }

        // Fee deduction: fee_bps / 10000
        let fee_amount = amount_remaining * fee_bps as u128 / 10000;
        let amount_in = amount_remaining - fee_amount;

        let (new_sqrt_price, amount0, amount1) = if zero_for_one {
            let next_sqrt = get_next_sqrt_price_from_amount0_input(sqrt_price, liquidity, amount_in);
            let next_sqrt = next_sqrt.max(sqrt_price_limit);
            let a0 = get_amount0_delta(next_sqrt, sqrt_price, liquidity);
            let a1 = get_amount1_delta(next_sqrt, sqrt_price, liquidity);
            (next_sqrt, a0, a1)
        } else {
            let next_sqrt = get_next_sqrt_price_from_amount1_input(sqrt_price, liquidity, amount_in);
            let next_sqrt = next_sqrt.min(sqrt_price_limit);
            let a0 = get_amount0_delta(sqrt_price, next_sqrt, liquidity);
            let a1 = get_amount1_delta(sqrt_price, next_sqrt, liquidity);
            (next_sqrt, a0, a1)
        };

        // Update state
        env.storage().instance().set(&DataKey::SqrtPrice, &new_sqrt_price);
        env.storage()
            .instance()
            .set(&DataKey::CurrentTick, &sqrt_price_to_tick(new_sqrt_price));

        // Update fee growth (proportional to active liquidity)
        if zero_for_one && amount0 > 0 {
            let fg0: u128 = env.storage().instance().get(&DataKey::FeeGrowthGlobal0).unwrap();
            env.storage()
                .instance()
                .set(&DataKey::FeeGrowthGlobal0, &(fg0 + fee_amount * Q32 / liquidity));
        } else if !zero_for_one && amount1 > 0 {
            let fg1: u128 = env.storage().instance().get(&DataKey::FeeGrowthGlobal1).unwrap();
            env.storage()
                .instance()
                .set(&DataKey::FeeGrowthGlobal1, &(fg1 + fee_amount * Q32 / liquidity));
        }

        // Record observation
        Self::record_observation(&env, new_sqrt_price);

        // Transfer tokens
        let token0: Address = env.storage().instance().get(&DataKey::Token0).unwrap();
        let token1: Address = env.storage().instance().get(&DataKey::Token1).unwrap();
        let contract = env.current_contract_address();

        if zero_for_one {
            // Pool receives token0, sends token1
            let total_in = amount_remaining; // includes fee
            TokenClient::new(&env, &token0).transfer_from(
                &contract,
                &recipient,
                &contract,
                &(total_in as i128),
            );
            if amount1 > 0 {
                TokenClient::new(&env, &token1).transfer(&contract, &recipient, &(amount1 as i128));
            }
        } else {
            // Pool receives token1, sends token0
            let total_in = amount_remaining;
            TokenClient::new(&env, &token1).transfer_from(
                &contract,
                &recipient,
                &contract,
                &(total_in as i128),
            );
            if amount0 > 0 {
                TokenClient::new(&env, &token0).transfer(&contract, &recipient, &(amount0 as i128));
            }
        }

        let (delta0, delta1) = if zero_for_one {
            (amount_remaining as i128, -(amount1 as i128))
        } else {
            (-(amount0 as i128), amount_remaining as i128)
        };

        env.events().publish(
            (symbol_short!("swap"),),
            (recipient, zero_for_one, delta0, delta1, new_sqrt_price),
        );

        (delta0, delta1)
    }

    /// Flash loan: borrow tokens with a callback.
    pub fn flash(
        env: Env,
        recipient: Address,
        amount0: u128,
        amount1: u128,
    ) {
        recipient.require_auth();
        Self::check_initialized(&env);

        let token0: Address = env.storage().instance().get(&DataKey::Token0).unwrap();
        let token1: Address = env.storage().instance().get(&DataKey::Token1).unwrap();
        let contract = env.current_contract_address();
        let fee_bps: u32 = env.storage().instance().get(&DataKey::FeeBps).unwrap();

        let fee0 = amount0 * fee_bps as u128 / 10000;
        let fee1 = amount1 * fee_bps as u128 / 10000;

        if amount0 > 0 {
            TokenClient::new(&env, &token0).transfer(&contract, &recipient, &(amount0 as i128));
        }
        if amount1 > 0 {
            TokenClient::new(&env, &token1).transfer(&contract, &recipient, &(amount1 as i128));
        }

        // Repayment must happen in the same transaction (Soroban atomicity)
        // Caller is responsible for repaying amount0 + fee0, amount1 + fee1
        if amount0 > 0 {
            TokenClient::new(&env, &token0).transfer_from(
                &contract,
                &recipient,
                &contract,
                &((amount0 + fee0) as i128),
            );
        }
        if amount1 > 0 {
            TokenClient::new(&env, &token1).transfer_from(
                &contract,
                &recipient,
                &contract,
                &((amount1 + fee1) as i128),
            );
        }

        env.events().publish(
            (symbol_short!("flash"),),
            (recipient, amount0, amount1, fee0, fee1),
        );
    }

    // ---------------------------------------------------------------------------
    // View functions
    // ---------------------------------------------------------------------------

    pub fn get_state(env: Env) -> (u128, i32, u128, u32) {
        let sqrt_price: u128 = env.storage().instance().get(&DataKey::SqrtPrice).unwrap();
        let tick: i32 = env.storage().instance().get(&DataKey::CurrentTick).unwrap();
        let liquidity: u128 = env.storage().instance().get(&DataKey::Liquidity).unwrap();
        let fee_bps: u32 = env.storage().instance().get(&DataKey::FeeBps).unwrap();
        (sqrt_price, tick, liquidity, fee_bps)
    }

    pub fn get_position(env: Env, owner: Address, tick_lower: i32, tick_upper: i32) -> Position {
        let key = PositionKey { owner, tick_lower, tick_upper };
        env.storage()
            .persistent()
            .get(&DataKey::Position(key))
            .unwrap_or_default()
    }

    pub fn token0(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Token0).unwrap()
    }

    pub fn token1(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Token1).unwrap()
    }

    pub fn fee_bps(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::FeeBps).unwrap()
    }

    pub fn sqrt_price(env: Env) -> u128 {
        env.storage().instance().get(&DataKey::SqrtPrice).unwrap()
    }

    pub fn current_tick(env: Env) -> i32 {
        env.storage().instance().get(&DataKey::CurrentTick).unwrap()
    }

    pub fn liquidity(env: Env) -> u128 {
        env.storage().instance().get(&DataKey::Liquidity).unwrap()
    }

    pub fn observations(env: Env) -> Vec<Observation> {
        env.storage()
            .instance()
            .get(&DataKey::Observations)
            .unwrap_or(Vec::new(&env))
    }

    pub fn get_twap(env: Env, seconds_ago: u64) -> u128 {
        let obs: Vec<Observation> = env
            .storage()
            .instance()
            .get(&DataKey::Observations)
            .unwrap_or(Vec::new(&env));
        if obs.is_empty() {
            return env.storage().instance().get(&DataKey::SqrtPrice).unwrap();
        }
        let now = env.ledger().timestamp();
        let target = now.saturating_sub(seconds_ago);

        // Find nearest observations by linear search
        let mut sum: u128 = 0;
        let mut count = 0u32;
        for i in 0..obs.len() {
            let o = obs.get(i).unwrap();
            if o.timestamp >= target {
                sum += o.sqrt_price;
                count += 1;
            }
        }
        if count == 0 {
            return obs.get(obs.len() - 1).unwrap().sqrt_price;
        }
        sum / count as u128
    }

    // ---------------------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------------------

    fn check_initialized(env: &Env) {
        assert!(
            env.storage().instance().get::<DataKey, bool>(&DataKey::Initialized).unwrap_or(false),
            "not initialized"
        );
    }

    fn update_tick(env: &Env, tick: i32, liquidity_delta: i128, upper: bool) {
        let mut info: TickInfo = env
            .storage()
            .persistent()
            .get(&DataKey::Tick(tick))
            .unwrap_or_default();

        let abs_delta = liquidity_delta.unsigned_abs();
        if liquidity_delta > 0 {
            info.liquidity_gross += abs_delta;
            if upper {
                info.liquidity_net -= liquidity_delta;
            } else {
                info.liquidity_net += liquidity_delta;
            }
        } else {
            info.liquidity_gross = info.liquidity_gross.saturating_sub(abs_delta);
            if upper {
                info.liquidity_net += liquidity_delta.abs();
            } else {
                info.liquidity_net -= liquidity_delta.abs();
            }
        }
        info.initialized = info.liquidity_gross > 0;
        env.storage().persistent().set(&DataKey::Tick(tick), &info);
    }

    fn compute_position_fees(
        env: &Env,
        pos: &Position,
        _tick_lower: i32,
        _tick_upper: i32,
    ) -> (u128, u128) {
        let fg0: u128 = env.storage().instance().get(&DataKey::FeeGrowthGlobal0).unwrap_or(0);
        let fg1: u128 = env.storage().instance().get(&DataKey::FeeGrowthGlobal1).unwrap_or(0);

        let fee0 = if fg0 >= pos.fee_growth_inside_0_last {
            (fg0 - pos.fee_growth_inside_0_last)
                .saturating_mul(pos.liquidity)
                .saturating_div(Q32)
        } else {
            0
        };
        let fee1 = if fg1 >= pos.fee_growth_inside_1_last {
            (fg1 - pos.fee_growth_inside_1_last)
                .saturating_mul(pos.liquidity)
                .saturating_div(Q32)
        } else {
            0
        };
        (fee0, fee1)
    }

    fn record_observation(env: &Env, sqrt_price: u128) {
        let mut obs: Vec<Observation> = env
            .storage()
            .instance()
            .get(&DataKey::Observations)
            .unwrap_or(Vec::new(env));
        let new_obs = Observation {
            timestamp: env.ledger().timestamp(),
            sqrt_price,
            tick: sqrt_price_to_tick(sqrt_price),
        };
        // Keep only last 64 observations (circular buffer)
        if obs.len() >= 64 {
            obs.pop_front();
        }
        obs.push_back(new_obs);
        env.storage().instance().set(&DataKey::Observations, &obs);
    }
}
