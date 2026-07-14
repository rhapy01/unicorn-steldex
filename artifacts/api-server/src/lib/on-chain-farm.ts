import type { xdr } from "@stellar/stellar-sdk";
import { getContractConfig } from "./contract-config.js";
import { listOnChainPools } from "./on-chain-pools.js";
import { fullRangeTicks } from "./pool-ticks.js";
import { tickToSqrtQ32, liquidityToAmounts } from "./clmm-math.js";
import { decimalsForContract } from "./token-decimals.js";
import { buildOnChainCatalog } from "./market-catalog.js";

type StellarSdk = typeof import("@stellar/stellar-sdk");
type RpcServer = InstanceType<StellarSdk["rpc"]["Server"]>;
type ScVal = xdr.ScVal;

const SIM_SOURCE = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const RPC = "https://soroban-testnet.stellar.org";
const STELLAR_DECIMALS = 7;

async function stellar() {
  return import("@stellar/stellar-sdk");
}

function scMapField(sdk: StellarSdk, val: ScVal, key: string): bigint {
  const entries = val.map() ?? [];
  for (const e of entries) {
    if (e.key().sym().toString() === key) {
      return sdk.scValToBigInt(e.val());
    }
  }
  return 0n;
}

function scMapU32(sdk: StellarSdk, val: ScVal, key: string): number {
  return Number(scMapField(sdk, val, key));
}

function scMapBool(val: ScVal, key: string): boolean {
  const entries = val.map() ?? [];
  for (const e of entries) {
    if (e.key().sym().toString() === key) {
      return e.val().b() ?? false;
    }
  }
  return false;
}

function boostMultiplier(lockWeeks: number): number {
  const w = Math.min(lockWeeks, 156);
  return 1.0 + (w / 156) * 1.5;
}

function toStellarHuman(raw: bigint): number {
  return Number(raw) / 10 ** STELLAR_DECIMALS;
}

async function simulateFarm(
  sdk: StellarSdk,
  server: RpcServer,
  farmAddress: string,
  method: string,
  args: ScVal[] = [],
): Promise<ScVal | null> {
  const source = await server.getAccount(SIM_SOURCE);
  const farm = new sdk.Contract(farmAddress);
  const tx = new sdk.TransactionBuilder(source, {
    fee: "100000",
    networkPassphrase: TESTNET_PASSPHRASE,
  })
    .addOperation(farm.call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (sdk.rpc.Api.isSimulationError(sim) || !sim.result?.retval) return null;
  return sim.result.retval;
}

export type FarmPoolState = {
  weeklyStellar: string;
  weeklyStellarHuman: number;
  totalStaked: string;
  aprPercent: number;
  aprDataReliable: boolean;
};

/** Human-readable breakdown of a liquidity balance (staked or unstaked). */
export type LpBalanceInfo = {
  liquidity: string;
  token0Amount: number;
  token1Amount: number;
  valueUsd: number;
};

export type FarmStakeInfo = {
  liquidity: string;
  lockEndLedger: number;
  lockWeeks: number;
  pendingRewards: string;
  pendingRewardsHuman: number;
  pendingRewardsUsd: number;
  autoCompound: boolean;
  stakedAt: number;
  boostMultiplier: number;
};

export type FarmPoolRow = {
  poolContract: string;
  pair: string;
  token0Symbol: string;
  token1Symbol: string;
  token0Contract: string;
  token1Contract: string;
  tvlUsd: number;
  farm: FarmPoolState;
  // Raw liquidity strings (internal units)
  lpLiquidity?: string;
  stakedLiquidity?: string;
  availableToStake?: string;
  // Human-readable breakdowns (wallet-gated)
  lpBalance?: LpBalanceInfo;       // unstaked portion
  stakedBalance?: LpBalanceInfo;   // staked in farm
  userValueUsd?: number;           // lpBalance.valueUsd + stakedBalance.valueUsd
  rewardsEarnedUsd?: number;       // pending rewards converted to USD
  pendingRewardsHuman?: number;
};

export type FarmPosition = {
  poolContract: string;
  pair: string;
  token0Symbol: string;
  token1Symbol: string;
  token0Contract: string;
  token1Contract: string;
  tickLower: number;
  tickUpper: number;
  stake: FarmStakeInfo;
  pendingRewardsHuman: number;
  rewardsEarnedUsd: number;
  stakedBalance: LpBalanceInfo;
};

export type FarmOverview = {
  totalWeeklyStellar: number;
  totalStakedLiquidity: string;
  poolCount: number;
  maxBoost: number;
  userPendingRewards?: number;
};

function parsePoolFarmState(sdk: StellarSdk, val: ScVal, tvlUsd?: number): FarmPoolState {
  const weekly = scMapField(sdk, val, "weekly_stellar");
  const totalStaked = scMapField(sdk, val, "total_staked");
  const weeklyHuman = toStellarHuman(weekly);

  // Get STELLAR price from the catalog
  const catalog = buildOnChainCatalog();
  const stellarToken = catalog.tokens.find((t) => t.symbol === "STELLAR");
  const stellarPrice = stellarToken?.price ?? 0;

  // Correct APR: normalize to USD before comparing
  // APR = (weeklyRewardsUsd / totalStakedUsd) * 52 weeks * 100%
  // tvlUsd is the total pool TVL (used as proxy for totalStakedUsd when available)
  let aprPercent = 0;
  let aprDataReliable = false;
  const weeklyUsd = weeklyHuman * stellarPrice;
  const stakedUsd = (tvlUsd && tvlUsd > 0) ? tvlUsd : 0;

  if (stakedUsd > 0 && weeklyUsd >= 0 && stellarPrice > 0) {
    const raw = (weeklyUsd / stakedUsd) * 52 * 100;
    // Sanity cap: anything above 99,900% is clearly bad data
    aprPercent = raw > 99_900 ? 0 : raw;
    aprDataReliable = raw <= 99_900;
  }

  return {
    weeklyStellar: weekly.toString(),
    weeklyStellarHuman: weeklyHuman,
    totalStaked: totalStaked.toString(),
    aprPercent: Math.round(aprPercent * 100) / 100, // round to 2dp
    aprDataReliable,
  };
}

function parseStakeInfo(sdk: StellarSdk, val: ScVal): FarmStakeInfo | null {
  if (val.switch().name === "scvVoid") return null;
  const liquidity = scMapField(sdk, val, "liquidity");
  if (liquidity === 0n) return null;
  const lockWeeks = scMapU32(sdk, val, "lock_weeks");
  const pending = scMapField(sdk, val, "pending_rewards");

  const catalog = buildOnChainCatalog();
  const stellarToken = catalog.tokens.find((t) => t.symbol === "STELLAR");
  const stellarPrice = stellarToken?.price ?? 0;
  const pendingHuman = toStellarHuman(pending);

  return {
    liquidity: liquidity.toString(),
    lockEndLedger: scMapU32(sdk, val, "lock_end_ledger"),
    lockWeeks,
    pendingRewards: pending.toString(),
    pendingRewardsHuman: pendingHuman,
    pendingRewardsUsd: pendingHuman * stellarPrice,
    autoCompound: scMapBool(val, "auto_compound"),
    stakedAt: Number(scMapField(sdk, val, "staked_at")),
    boostMultiplier: boostMultiplier(lockWeeks),
  };
}

async function readPoolPositionLiquidity(
  sdk: StellarSdk,
  server: RpcServer,
  poolAddress: string,
  owner: string,
  tickLower: number,
  tickUpper: number,
): Promise<bigint> {
  const source = await server.getAccount(SIM_SOURCE);
  const pool = new sdk.Contract(poolAddress);
  const tx = new sdk.TransactionBuilder(source, {
    fee: "100000",
    networkPassphrase: TESTNET_PASSPHRASE,
  })
    .addOperation(
      pool.call(
        "get_position",
        new sdk.Address(owner).toScVal(),
        sdk.nativeToScVal(tickLower, { type: "i32" }),
        sdk.nativeToScVal(tickUpper, { type: "i32" }),
      ),
    )
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (sdk.rpc.Api.isSimulationError(sim) || !sim.result?.retval) return 0n;
  const val = sim.result.retval;
  if (val.switch().name === "scvMap") {
    return scMapField(sdk, val, "liquidity");
  }
  const vec = val.vec() ?? [];
  if (vec.length >= 1) return sdk.scValToBigInt(vec[0]);
  return 0n;
}

export async function readFarmPoolState(poolContract: string, tvlUsd?: number): Promise<FarmPoolState> {
  const config = getContractConfig();
  if (!config.farm) {
    return {
      weeklyStellar: "0",
      weeklyStellarHuman: 0,
      totalStaked: "0",
      aprPercent: 0,
      aprDataReliable: false,
    };
  }
  const sdk = await stellar();
  const server = new sdk.rpc.Server(RPC);
  const val = await simulateFarm(sdk, server, config.farm, "pool_state", [
    new sdk.Address(poolContract).toScVal(),
  ]);
  if (!val || val.switch().name !== "scvMap") {
    return {
      weeklyStellar: "0",
      weeklyStellarHuman: 0,
      totalStaked: "0",
      aprPercent: 0,
      aprDataReliable: false,
    };
  }
  return parsePoolFarmState(sdk, val, tvlUsd);
}

export async function readFarmStake(
  owner: string,
  poolContract: string,
  tickLower: number,
  tickUpper: number,
): Promise<FarmStakeInfo | null> {
  const config = getContractConfig();
  if (!config.farm) return null;
  const sdk = await stellar();
  const server = new sdk.rpc.Server(RPC);
  const val = await simulateFarm(sdk, server, config.farm, "get_stake", [
    new sdk.Address(owner).toScVal(),
    new sdk.Address(poolContract).toScVal(),
    sdk.nativeToScVal(tickLower, { type: "i32" }),
    sdk.nativeToScVal(tickUpper, { type: "i32" }),
  ]);
  if (!val) return null;
  return parseStakeInfo(sdk, val);
}

export async function readPendingRewards(
  owner: string,
  poolContract: string,
  tickLower: number,
  tickUpper: number,
): Promise<number> {
  const config = getContractConfig();
  if (!config.farm) return 0;
  const sdk = await stellar();
  const server = new sdk.rpc.Server(RPC);
  const val = await simulateFarm(sdk, server, config.farm, "pending_rewards", [
    new sdk.Address(owner).toScVal(),
    new sdk.Address(poolContract).toScVal(),
    sdk.nativeToScVal(tickLower, { type: "i32" }),
    sdk.nativeToScVal(tickUpper, { type: "i32" }),
  ]);
  if (!val) return 0;
  return toStellarHuman(sdk.scValToBigInt(val));
}

/** Compute human-readable token amounts and USD value for a liquidity amount. */
function buildLpBalanceInfo(
  liquidity: bigint,
  sqrtPrice: bigint,
  sqrtPa: bigint,
  sqrtPb: bigint,
  token0Decimals: number,
  token1Decimals: number,
  token0PriceUsd: number,
  token1PriceUsd: number,
): LpBalanceInfo {
  if (liquidity === 0n) {
    return { liquidity: "0", token0Amount: 0, token1Amount: 0, valueUsd: 0 };
  }
  const { amount0, amount1 } = liquidityToAmounts(sqrtPrice, sqrtPa, sqrtPb, liquidity);
  const token0Amount = Number(amount0) / 10 ** token0Decimals;
  const token1Amount = Number(amount1) / 10 ** token1Decimals;
  const valueUsd = token0Amount * token0PriceUsd + token1Amount * token1PriceUsd;
  return {
    liquidity: liquidity.toString(),
    token0Amount,
    token1Amount,
    valueUsd,
  };
}

export async function listOnChainFarmPools(walletAddress?: string): Promise<FarmPoolRow[]> {
  const pools = await listOnChainPools();
  const { tickLower, tickUpper } = fullRangeTicks();
  const sdk = await stellar();
  const server = new sdk.rpc.Server(RPC);
  const sqrtPa = tickToSqrtQ32(tickLower);
  const sqrtPb = tickToSqrtQ32(tickUpper);

  // Build token price map from catalog
  const catalog = buildOnChainCatalog();
  const priceBySymbol: Record<string, number> = {};
  const priceByContract: Record<string, number> = {};
  for (const t of catalog.tokens) {
    priceBySymbol[t.symbol] = t.price;
    if (t.contractAddress) priceByContract[t.contractAddress] = t.price;
  }
  const stellarPrice = priceBySymbol["STELLAR"] ?? 0;
  const config = getContractConfig();

  const rows = await Promise.all(
    pools.map(async (p) => {
      if (!p.poolContract || !p.pair) return null;

      // Get pool token contracts from the registry (already in CatalogPool via tokenA/tokenB)
      const token0Contract = p.tokenA.contractAddress ?? "";
      const token1Contract = p.tokenB.contractAddress ?? "";
      const token0Symbol = p.tokenA.symbol;
      const token1Symbol = p.tokenB.symbol;
      const token0PriceUsd = p.tokenA.price;
      const token1PriceUsd = p.tokenB.price;
      const token0Decimals = decimalsForContract(token0Contract, config);
      const token1Decimals = decimalsForContract(token1Contract, config);

      const farm = await readFarmPoolState(p.poolContract, p.totalLiquidity);

      const row: FarmPoolRow = {
        poolContract: p.poolContract,
        pair: p.pair,
        token0Symbol,
        token1Symbol,
        token0Contract,
        token1Contract,
        tvlUsd: p.totalLiquidity,
        farm,
      };

      if (walletAddress) {
        // Fetch sqrt price, LP position and stake in parallel
        let sqrtPrice: bigint;
        try {
          const source = await server.getAccount(SIM_SOURCE);
          const poolC = new sdk.Contract(p.poolContract);
          const tx = new sdk.TransactionBuilder(source, {
            fee: "100000",
            networkPassphrase: TESTNET_PASSPHRASE,
          })
            .addOperation(poolC.call("sqrt_price"))
            .setTimeout(30)
            .build();
          const sim = await server.simulateTransaction(tx);
          sqrtPrice =
            !sdk.rpc.Api.isSimulationError(sim) && sim.result?.retval
              ? sdk.scValToBigInt(sim.result.retval)
              : tickToSqrtQ32(0);
        } catch {
          sqrtPrice = tickToSqrtQ32(0);
        }

        const [lpLiq, stake] = await Promise.all([
          readPoolPositionLiquidity(sdk, server, p.poolContract, walletAddress, tickLower, tickUpper),
          readFarmStake(walletAddress, p.poolContract, tickLower, tickUpper),
        ]);

        const staked = stake ? BigInt(stake.liquidity) : 0n;
        const available = lpLiq > staked ? lpLiq - staked : 0n;

        row.lpLiquidity = lpLiq.toString();
        row.stakedLiquidity = staked.toString();
        row.availableToStake = available.toString();

        // Human-readable breakdowns
        row.lpBalance = buildLpBalanceInfo(
          available, sqrtPrice, sqrtPa, sqrtPb,
          token0Decimals, token1Decimals, token0PriceUsd, token1PriceUsd,
        );
        row.stakedBalance = buildLpBalanceInfo(
          staked, sqrtPrice, sqrtPa, sqrtPb,
          token0Decimals, token1Decimals, token0PriceUsd, token1PriceUsd,
        );
        row.userValueUsd = row.lpBalance.valueUsd + row.stakedBalance.valueUsd;

        // Pending rewards in USD
        if (stake) {
          row.pendingRewardsHuman = stake.pendingRewardsHuman;
          row.rewardsEarnedUsd = stake.pendingRewardsHuman * stellarPrice;
        } else {
          row.pendingRewardsHuman = 0;
          row.rewardsEarnedUsd = 0;
        }
      }

      return row;
    }),
  );

  return rows.filter((r): r is FarmPoolRow => r !== null);
}

export async function getOnChainFarmPositions(walletAddress: string): Promise<FarmPosition[]> {
  const pools = await listOnChainPools();
  const { tickLower, tickUpper } = fullRangeTicks();
  const sdk = await stellar();
  const server = new sdk.rpc.Server(RPC);
  const sqrtPa = tickToSqrtQ32(tickLower);
  const sqrtPb = tickToSqrtQ32(tickUpper);

  const catalog = buildOnChainCatalog();
  const priceBySymbol: Record<string, number> = {};
  for (const t of catalog.tokens) priceBySymbol[t.symbol] = t.price;
  const stellarPrice = priceBySymbol["STELLAR"] ?? 0;
  const config = getContractConfig();

  const positions = await Promise.all(
    pools.map(async (p) => {
      if (!p.poolContract || !p.pair) return null;
      const stake = await readFarmStake(walletAddress, p.poolContract, tickLower, tickUpper);
      if (!stake) return null;

      const pendingRewardsHuman = await readPendingRewards(
        walletAddress,
        p.poolContract,
        tickLower,
        tickUpper,
      );

      const token0Contract = p.tokenA.contractAddress ?? "";
      const token1Contract = p.tokenB.contractAddress ?? "";
      const token0Decimals = decimalsForContract(token0Contract, config);
      const token1Decimals = decimalsForContract(token1Contract, config);
      const token0PriceUsd = p.tokenA.price;
      const token1PriceUsd = p.tokenB.price;

      // Fetch sqrt price for token amount computation
      let sqrtPrice: bigint;
      try {
        const source = await server.getAccount(SIM_SOURCE);
        const poolC = new sdk.Contract(p.poolContract);
        const tx = new sdk.TransactionBuilder(source, {
          fee: "100000",
          networkPassphrase: TESTNET_PASSPHRASE,
        })
          .addOperation(poolC.call("sqrt_price"))
          .setTimeout(30)
          .build();
        const sim = await server.simulateTransaction(tx);
        sqrtPrice =
          !sdk.rpc.Api.isSimulationError(sim) && sim.result?.retval
            ? sdk.scValToBigInt(sim.result.retval)
            : tickToSqrtQ32(0);
      } catch {
        sqrtPrice = tickToSqrtQ32(0);
      }

      const stakedBalance = buildLpBalanceInfo(
        BigInt(stake.liquidity),
        sqrtPrice, sqrtPa, sqrtPb,
        token0Decimals, token1Decimals, token0PriceUsd, token1PriceUsd,
      );

      return {
        poolContract: p.poolContract,
        pair: p.pair,
        token0Symbol: p.tokenA.symbol,
        token1Symbol: p.tokenB.symbol,
        token0Contract,
        token1Contract,
        tickLower,
        tickUpper,
        stake,
        pendingRewardsHuman,
        rewardsEarnedUsd: pendingRewardsHuman * stellarPrice,
        stakedBalance,
      } satisfies FarmPosition;
    }),
  );

  return positions.filter((p): p is FarmPosition => p !== null);
}

export async function getOnChainFarmOverview(walletAddress?: string): Promise<FarmOverview> {
  const rows = await listOnChainFarmPools();
  let totalWeeklyStellar = 0;
  let totalStaked = 0n;
  for (const row of rows) {
    totalWeeklyStellar += row.farm.weeklyStellarHuman;
    totalStaked += BigInt(row.farm.totalStaked);
  }

  let userPendingRewards: number | undefined;
  if (walletAddress) {
    const positions = await getOnChainFarmPositions(walletAddress);
    userPendingRewards = positions.reduce((sum, p) => sum + p.pendingRewardsHuman, 0);
  }

  return {
    totalWeeklyStellar,
    totalStakedLiquidity: totalStaked.toString(),
    poolCount: rows.length,
    maxBoost: 2.5,
    userPendingRewards,
  };
}
