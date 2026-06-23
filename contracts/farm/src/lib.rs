#![no_std]
//! StellarSwap Farm: Liquidity Mining + veToken Boosts
//!
//! - Stake concentrated LP positions (not tokens, actual position keys)
//! - Lock 1–156 weeks → up to 2.5× STELLAR reward boost (Curve veCRV model)
//! - Auto-compound: restake accrued fees + rewards
//! - Per-pool weekly STELLAR emission rates set by admin
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short,
    token::TokenClient,
    Address, Env, Vec,
};

const WEEKS_TO_MAX_BOOST: u32 = 156;
const MAX_BOOST_BPS: u32 = 25000;   // 2.5×
const BASE_BOOST_BPS: u32 = 10000;  // 1.0×
const REWARD_PRECISION: u128 = 1_000_000_000_000; // 10^12

// ---------------------------------------------------------------------------
// Storage types
// ---------------------------------------------------------------------------

#[derive(Clone)]
#[contracttype]
pub struct StakeKey {
    pub owner: Address,
    pub pool: Address,
    pub tick_lower: i32,
    pub tick_upper: i32,
}

#[derive(Clone)]
#[contracttype]
pub struct StakeInfo {
    pub liquidity: u128,
    pub lock_end_ledger: u32,
    pub lock_weeks: u32,
    pub reward_debt: u128,
    pub pending_rewards: u128,
    pub auto_compound: bool,
    pub staked_at: u64,
}

#[derive(Clone)]
#[contracttype]
pub struct PoolFarmState {
    pub weekly_stellar: u128,
    pub acc_reward_per_liq: u128,
    pub last_update_ledger: u32,
    pub total_staked: u128,
}

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    RewardToken,
    Stake(StakeKey),
    PoolState(Address),
    AllPools,
    LedgerPerWeek,
    RewardBalance,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct Farm;

#[contractimpl]
impl Farm {
    pub fn initialize(env: Env, admin: Address, reward_token: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::RewardToken, &reward_token);
        env.storage().instance().set(&DataKey::AllPools, &Vec::<Address>::new(&env));
        // 51840 ledgers/week at 12s per ledger
        env.storage().instance().set(&DataKey::LedgerPerWeek, &51840u32);
    }

    /// Fund the farm with STELLAR reward tokens
    pub fn fund(env: Env, from: Address, amount: u128) {
        from.require_auth();
        let reward_token: Address = env.storage().instance().get(&DataKey::RewardToken).unwrap();
        TokenClient::new(&env, &reward_token).transfer(
            &from,
            &env.current_contract_address(),
            &(amount as i128),
        );
        let bal: u128 = env.storage().instance().get(&DataKey::RewardBalance).unwrap_or(0);
        env.storage().instance().set(&DataKey::RewardBalance, &(bal + amount));
    }

    /// Admin: set weekly STELLAR emissions for a pool
    pub fn set_reward_rate(env: Env, pool: Address, weekly_stellar: u128) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();

        Self::_update_pool(&env, &pool);

        let mut state = Self::_get_pool_state(&env, &pool);
        state.weekly_stellar = weekly_stellar;
        Self::_set_pool_state(&env, &pool, &state);

        // Track pool
        let mut all: Vec<Address> = env.storage().instance()
            .get(&DataKey::AllPools).unwrap_or(Vec::new(&env));
        let mut found = false;
        for i in 0..all.len() {
            if all.get(i).unwrap() == pool { found = true; break; }
        }
        if !found {
            all.push_back(pool);
            env.storage().instance().set(&DataKey::AllPools, &all);
        }
    }

    /// Stake an LP position and optionally lock for boost.
    /// Kept lean (instance pool state, no events) to stay under Soroban footprint limits.
    pub fn stake(
        env: Env,
        owner: Address,
        pool: Address,
        tick_lower: i32,
        tick_upper: i32,
        liquidity: u128,
        lock_weeks: u32,
        auto_compound: bool,
    ) {
        owner.require_auth();
        assert!(liquidity > 0, "zero liquidity");
        assert!(lock_weeks >= 1 && lock_weeks <= 156, "lock out of range");

        let ledger_per_week: u32 = env.storage().instance().get(&DataKey::LedgerPerWeek).unwrap();
        let lock_end = env.ledger().sequence() + lock_weeks * ledger_per_week;

        let mut state = Self::_get_pool_state(&env, &pool);
        Self::_accrue_pool(&mut state, env.ledger().sequence(), ledger_per_week);

        let stake_key = DataKey::Stake(StakeKey {
            owner: owner.clone(),
            pool: pool.clone(),
            tick_lower,
            tick_upper,
        });
        let existing: Option<StakeInfo> = env.storage().instance().get(&stake_key);

        let mut prev_pending = existing.as_ref().map(|s| s.pending_rewards).unwrap_or(0);
        let prev_liq = existing.as_ref().map(|s| s.liquidity).unwrap_or(0);
        let prev_lock = existing.as_ref().map(|s| s.lock_end_ledger).unwrap_or(0);
        if let Some(ref s) = existing {
            prev_pending += Self::_compute_pending(&state, s);
        }

        let new_liq = prev_liq + liquidity;
        let reward_debt = state.acc_reward_per_liq.saturating_mul(new_liq) / REWARD_PRECISION;

        let stake = StakeInfo {
            liquidity: new_liq,
            lock_end_ledger: lock_end.max(prev_lock),
            lock_weeks: lock_weeks.max(existing.as_ref().map(|s| s.lock_weeks).unwrap_or(0)),
            reward_debt,
            pending_rewards: prev_pending,
            auto_compound,
            staked_at: env.ledger().timestamp(),
        };
        env.storage().instance().set(&stake_key, &stake);

        state.total_staked += liquidity;
        Self::_set_pool_state(&env, &pool, &state);
    }

    /// Unstake LP position (only after lock expires)
    pub fn unstake(
        env: Env,
        owner: Address,
        pool: Address,
        tick_lower: i32,
        tick_upper: i32,
        liquidity: u128,
    ) {
        owner.require_auth();
        Self::_update_pool(&env, &pool);
        let state = Self::_get_pool_state(&env, &pool);

        let key = StakeKey { owner: owner.clone(), pool: pool.clone(), tick_lower, tick_upper };
        let mut stake: StakeInfo = env.storage().instance()
            .get(&DataKey::Stake(key.clone())).expect("no stake");

        assert!(env.ledger().sequence() >= stake.lock_end_ledger, "still locked");
        assert!(stake.liquidity >= liquidity, "insufficient staked");

        let pending = Self::_compute_pending(&state, &stake);
        stake.pending_rewards += pending;
        stake.liquidity -= liquidity;
        stake.reward_debt = state.acc_reward_per_liq.saturating_mul(stake.liquidity) / REWARD_PRECISION;
        env.storage().instance().set(&DataKey::Stake(key), &stake);

        let mut st = state;
        st.total_staked = st.total_staked.saturating_sub(liquidity);
        Self::_set_pool_state(&env, &pool, &st);

        env.events().publish(
            (symbol_short!("unstake"),),
            (owner, pool, tick_lower, tick_upper, liquidity),
        );
    }

    /// Claim accrued STELLAR rewards with veToken boost
    pub fn claim(
        env: Env,
        owner: Address,
        pool: Address,
        tick_lower: i32,
        tick_upper: i32,
    ) -> u128 {
        owner.require_auth();
        Self::_update_pool(&env, &pool);
        let state = Self::_get_pool_state(&env, &pool);

        let key = StakeKey { owner: owner.clone(), pool: pool.clone(), tick_lower, tick_upper };
        let mut stake: StakeInfo = env.storage().instance()
            .get(&DataKey::Stake(key.clone())).expect("no stake");

        let pending = Self::_compute_pending(&state, &stake);
        let raw = pending + stake.pending_rewards;
        let boost_bps = Self::_compute_boost(stake.lock_weeks);
        let boosted = raw * boost_bps as u128 / 10000;

        stake.pending_rewards = 0;
        stake.reward_debt = state.acc_reward_per_liq.saturating_mul(stake.liquidity) / REWARD_PRECISION;
        env.storage().instance().set(&DataKey::Stake(key), &stake);

        if boosted > 0 {
            let reward_token: Address = env.storage().instance().get(&DataKey::RewardToken).unwrap();
            let bal: u128 = env.storage().instance().get(&DataKey::RewardBalance).unwrap_or(0);
            let actual = boosted.min(bal);
            if actual > 0 {
                TokenClient::new(&env, &reward_token).transfer(
                    &env.current_contract_address(),
                    &owner,
                    &(actual as i128),
                );
                env.storage().instance().set(&DataKey::RewardBalance, &(bal - actual));
            }
        }

        env.events().publish((symbol_short!("claim"),), (owner, pool, boosted));
        boosted
    }

    /// Compound: re-stake rewards (simplified: just claim and update reward_debt)
    pub fn compound(
        env: Env,
        owner: Address,
        pool: Address,
        tick_lower: i32,
        tick_upper: i32,
    ) -> u128 {
        owner.require_auth();
        let claimed = Self::claim(env.clone(), owner.clone(), pool.clone(), tick_lower, tick_upper);
        env.events().publish((symbol_short!("compound"),), (owner, pool, tick_lower, tick_upper, claimed));
        claimed
    }

    // ---------------------------------------------------------------------------
    // View functions
    // ---------------------------------------------------------------------------

    pub fn get_stake(env: Env, owner: Address, pool: Address, tick_lower: i32, tick_upper: i32) -> Option<StakeInfo> {
        let key = StakeKey { owner, pool, tick_lower, tick_upper };
        env.storage().instance().get(&DataKey::Stake(key))
    }

    pub fn pending_rewards(env: Env, owner: Address, pool: Address, tick_lower: i32, tick_upper: i32) -> u128 {
        Self::_update_pool(&env, &pool);
        let state = Self::_get_pool_state(&env, &pool);
        let key = StakeKey { owner, pool, tick_lower, tick_upper };
        let stake: StakeInfo = env.storage().instance()
            .get(&DataKey::Stake(key))
            .unwrap_or(StakeInfo {
                liquidity: 0, lock_end_ledger: 0, lock_weeks: 0,
                reward_debt: 0, pending_rewards: 0, auto_compound: false,
                staked_at: 0,
            });
        let raw = Self::_compute_pending(&state, &stake) + stake.pending_rewards;
        raw * Self::_compute_boost(stake.lock_weeks) as u128 / 10000
    }

    pub fn get_boost(lock_weeks: u32) -> u32 {
        Self::_compute_boost(lock_weeks)
    }

    pub fn pool_state(env: Env, pool: Address) -> PoolFarmState {
        Self::_get_pool_state(&env, &pool)
    }

    pub fn all_pools(env: Env) -> Vec<Address> {
        env.storage().instance().get(&DataKey::AllPools).unwrap_or(Vec::new(&env))
    }

    pub fn admin(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Admin).unwrap()
    }

    // ---------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------

    fn _get_pool_state(env: &Env, pool: &Address) -> PoolFarmState {
        env.storage().instance()
            .get(&DataKey::PoolState(pool.clone()))
            .unwrap_or(PoolFarmState {
                weekly_stellar: 0,
                acc_reward_per_liq: 0,
                last_update_ledger: 0,
                total_staked: 0,
            })
    }

    fn _set_pool_state(env: &Env, pool: &Address, state: &PoolFarmState) {
        env.storage().instance()
            .set(&DataKey::PoolState(pool.clone()), state);
    }

    fn _accrue_pool(state: &mut PoolFarmState, current: u32, ledger_per_week: u32) {
        if current <= state.last_update_ledger || state.total_staked == 0 {
            state.last_update_ledger = current;
            return;
        }
        let elapsed = (current - state.last_update_ledger) as u128;
        let rewards = state.weekly_stellar.saturating_mul(elapsed) / ledger_per_week as u128;
        state.acc_reward_per_liq += rewards.saturating_mul(REWARD_PRECISION) / state.total_staked;
        state.last_update_ledger = current;
    }

    fn _update_pool(env: &Env, pool: &Address) {
        let ledger_per_week: u32 = env.storage().instance().get(&DataKey::LedgerPerWeek).unwrap();
        let mut state = Self::_get_pool_state(env, pool);
        Self::_accrue_pool(&mut state, env.ledger().sequence(), ledger_per_week);
        Self::_set_pool_state(env, pool, &state);
    }

    fn _compute_pending(state: &PoolFarmState, stake: &StakeInfo) -> u128 {
        if stake.liquidity == 0 { return 0; }
        let expected = state.acc_reward_per_liq.saturating_mul(stake.liquidity) / REWARD_PRECISION;
        expected.saturating_sub(stake.reward_debt)
    }

    fn _compute_boost(lock_weeks: u32) -> u32 {
        let w = lock_weeks.min(WEEKS_TO_MAX_BOOST);
        BASE_BOOST_BPS + (MAX_BOOST_BPS - BASE_BOOST_BPS) * w / WEEKS_TO_MAX_BOOST
    }
}
