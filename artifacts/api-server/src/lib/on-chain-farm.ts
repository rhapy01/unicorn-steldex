import type { xdr } from "@stellar/stellar-sdk";
import { getContractConfig } from "./contract-config.js";
import { listOnChainPools } from "./on-chain-pools.js";
import { fullRangeTicks } from "./pool-ticks.js";

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
  baseAprPercent: number;
};

export type FarmStakeInfo = {
  liquidity: string;
  lockEndLedger: number;
  lockWeeks: number;
  pendingRewards: string;
  pendingRewardsHuman: number;
  autoCompound: boolean;
  stakedAt: number;
  boostMultiplier: number;
};

export type FarmPoolRow = {
  poolContract: string;
  pair: string;
  token0Symbol: string;
  token1Symbol: string;
  tvlUsd: number;
  farm: FarmPoolState;
  lpLiquidity?: string;
  stakedLiquidity?: string;
  availableToStake?: string;
};

export type FarmPosition = {
  poolContract: string;
  pair: string;
  token0Symbol: string;
  token1Symbol: string;
  tickLower: number;
  tickUpper: number;
  stake: FarmStakeInfo;
  pendingRewardsHuman: number;
};

export type FarmOverview = {
  totalWeeklyStellar: number;
  totalStakedLiquidity: string;
  poolCount: number;
  maxBoost: number;
  userPendingRewards?: number;
};

function parsePoolFarmState(sdk: StellarSdk, val: ScVal): FarmPoolState {
  const weekly = scMapField(sdk, val, "weekly_stellar");
  const totalStaked = scMapField(sdk, val, "total_staked");
  const weeklyHuman = toStellarHuman(weekly);
  const baseAprPercent =
    totalStaked > 0n
      ? (Number(weekly) / Number(totalStaked)) * 52 * 100
      : 0;
  return {
    weeklyStellar: weekly.toString(),
    weeklyStellarHuman: weeklyHuman,
    totalStaked: totalStaked.toString(),
    baseAprPercent,
  };
}

function parseStakeInfo(sdk: StellarSdk, val: ScVal): FarmStakeInfo | null {
  if (val.switch().name === "scvVoid") return null;
  const liquidity = scMapField(sdk, val, "liquidity");
  if (liquidity === 0n) return null;
  const lockWeeks = scMapU32(sdk, val, "lock_weeks");
  const pending = scMapField(sdk, val, "pending_rewards");
  return {
    liquidity: liquidity.toString(),
    lockEndLedger: scMapU32(sdk, val, "lock_end_ledger"),
    lockWeeks,
    pendingRewards: pending.toString(),
    pendingRewardsHuman: toStellarHuman(pending),
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

export async function readFarmPoolState(poolContract: string): Promise<FarmPoolState> {
  const config = getContractConfig();
  if (!config.farm) {
    return {
      weeklyStellar: "0",
      weeklyStellarHuman: 0,
      totalStaked: "0",
      baseAprPercent: 0,
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
      baseAprPercent: 0,
    };
  }
  return parsePoolFarmState(sdk, val);
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

export async function listOnChainFarmPools(walletAddress?: string): Promise<FarmPoolRow[]> {
  const pools = await listOnChainPools();
  const { tickLower, tickUpper } = fullRangeTicks();
  const sdk = await stellar();
  const server = new sdk.rpc.Server(RPC);

  const rows = await Promise.all(
    pools.map(async (p) => {
      if (!p.poolContract || !p.pair) return null;
      const [symA, symB] = p.pair.split("/");
      const farm = await readFarmPoolState(p.poolContract);
      const row: FarmPoolRow = {
        poolContract: p.poolContract,
        pair: p.pair,
        token0Symbol: symA,
        token1Symbol: symB,
        tvlUsd: p.totalLiquidity,
        farm,
      };

      if (walletAddress) {
        const [lpLiq, stake] = await Promise.all([
          readPoolPositionLiquidity(sdk, server, p.poolContract, walletAddress, tickLower, tickUpper),
          readFarmStake(walletAddress, p.poolContract, tickLower, tickUpper),
        ]);
        const staked = stake ? BigInt(stake.liquidity) : 0n;
        const available = lpLiq > staked ? lpLiq - staked : 0n;
        row.lpLiquidity = lpLiq.toString();
        row.stakedLiquidity = staked.toString();
        row.availableToStake = available.toString();
      }

      return row;
    }),
  );

  return rows.filter((r): r is FarmPoolRow => r !== null);
}

export async function getOnChainFarmPositions(walletAddress: string): Promise<FarmPosition[]> {
  const pools = await listOnChainPools();
  const { tickLower, tickUpper } = fullRangeTicks();

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
      const [symA, symB] = p.pair.split("/");
      return {
        poolContract: p.poolContract,
        pair: p.pair,
        token0Symbol: symA,
        token1Symbol: symB,
        tickLower,
        tickUpper,
        stake,
        pendingRewardsHuman,
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
