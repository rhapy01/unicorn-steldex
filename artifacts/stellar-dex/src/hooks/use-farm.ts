import { useQuery } from "@tanstack/react-query";

export type FarmPoolState = {
  weeklyStellar: string;
  weeklyStellarHuman: number;
  totalStaked: string;
  baseAprPercent: number;
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

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(String(err.error || `HTTP ${res.status}`));
  }
  return res.json() as Promise<T>;
}

export function useFarmPools(wallet?: string | null) {
  const qs = wallet ? `?wallet=${encodeURIComponent(wallet)}` : "";
  return useQuery({
    queryKey: ["farm-pools", wallet ?? ""],
    queryFn: () => fetchJson<FarmPoolRow[]>(`/api/stellar/farm-pools${qs}`),
    refetchInterval: 30_000,
  });
}

export function useFarmStats(wallet?: string | null) {
  const qs = wallet ? `?wallet=${encodeURIComponent(wallet)}` : "";
  return useQuery({
    queryKey: ["farm-stats", wallet ?? ""],
    queryFn: () => fetchJson<FarmOverview>(`/api/stellar/farm-stats${qs}`),
    refetchInterval: 30_000,
  });
}

export function useFarmPositions(wallet?: string | null) {
  return useQuery({
    queryKey: ["farm-positions", wallet ?? ""],
    queryFn: () =>
      wallet
        ? fetchJson<FarmPosition[]>(`/api/stellar/farm-positions?wallet=${encodeURIComponent(wallet)}`)
        : Promise.resolve([]),
    enabled: !!wallet,
    refetchInterval: 30_000,
  });
}
