/**
 * Soroban smart contract integration.
 * Flow: API builds unsigned XDR → wallet signs → this module submits to Soroban RPC.
 */
import { useCallback } from "react";
import { useWallet } from "./use-wallet";

const SOROBAN_RPC = "https://soroban-testnet.stellar.org";
const BASE_URL = "/api/stellar";

export type SwapOnChainParams = {
  fromTokenContract: string;
  toTokenContract: string;
  poolContract?: string;
  amountIn: string;
  minAmountOut?: string;
  slippageBps?: number;
  zeroForOne?: boolean;
  deadline?: number;
};

export type AddLiquidityOnChainParams = {
  poolContract?: string;
  token0Contract: string;
  token1Contract: string;
  tickLower: number;
  tickUpper: number;
  amount0Desired: string;
  amount1Desired: string;
  amount0Min?: string;
  amount1Min?: string;
  deadline?: number;
};

export type StakeFarmParams = {
  farmContract?: string;
  poolContract: string;
  tickLower: number;
  tickUpper: number;
  liquidity?: string;
  stakeMax?: boolean;
  lockWeeks: number;
  autoCompound: boolean;
};

async function sorobanRpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const res = await fetch(SOROBAN_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "Soroban RPC error");
  return data.result as T;
}

async function pollTransaction(hash: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const tx = await sorobanRpc<{ status: string }>("getTransaction", { hash });
    if (tx.status === "SUCCESS") return;
    if (tx.status === "FAILED") throw new Error("Transaction failed on-chain");
  }
  throw new Error("Transaction confirmation timed out");
}

/** POST to API to get unsigned XDR, then sign + submit */
async function buildAndSubmit(
  endpoint: string,
  body: Record<string, unknown>,
  walletAddress: string,
  signTx: (xdr: string) => Promise<string>,
): Promise<string> {
  const res = await fetch(`${BASE_URL}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, walletAddress }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    const message = String(err.error || `HTTP ${res.status}`).replace(/^Error:\s*/, "");
    throw new Error(message);
  }
  const data = await res.json();

  type TxStep = { id?: string; label?: string; xdr?: string };
  const steps: TxStep[] = Array.isArray(data.steps)
    ? data.steps
    : data.xdr
      ? [{ id: "tx", label: "Confirm transaction", xdr: data.xdr as string }]
      : [];

  if (steps.length === 0) throw new Error("API did not return transaction steps");

  let lastHash = "";
  for (const step of steps) {
    let xdr = step.xdr;
    if (!xdr && data.sequential && step.id) {
      const stepRes = await fetch(`${BASE_URL}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, walletAddress, stepId: step.id }),
      });
      if (!stepRes.ok) {
        const err = await stepRes.json().catch(() => ({ error: `HTTP ${stepRes.status}` }));
        throw new Error(String(err.error || `HTTP ${stepRes.status}`));
      }
      const stepData = await stepRes.json();
      xdr = stepData.xdr as string;
    }
    if (!xdr) throw new Error(`No XDR for step ${step.id ?? "unknown"}`);

    const signed = await signTx(xdr);
    const send = await sorobanRpc<{ status: string; hash?: string; errorResultXdr?: string }>(
      "sendTransaction",
      { transaction: signed }
    );

    if (send.status === "ERROR") {
      const label = step.label ? `${step.label}: ` : "";
      throw new Error(label + (send.errorResultXdr || "Submit failed"));
    }
    if (!send.hash) throw new Error("No transaction hash returned");

    await pollTransaction(send.hash);
    lastHash = send.hash;
  }
  return lastHash;
}

export function useStellarContract() {
  const { address, signTx } = useWallet();

  const wrap = useCallback(
    (endpoint: string, params: Record<string, unknown>) => {
      if (!address) return Promise.reject(new Error("Connect wallet first"));
      return buildAndSubmit(endpoint, params, address, signTx);
    },
    [address, signTx]
  );

  const executeSwap = useCallback(
    (params: SwapOnChainParams) => wrap("swap", params as unknown as Record<string, unknown>),
    [wrap]
  );

  const addLiquidity = useCallback(
    (params: AddLiquidityOnChainParams) => wrap("add-liquidity", params as unknown as Record<string, unknown>),
    [wrap]
  );

  const removeLiquidity = useCallback(
    (params: { poolContract: string; tickLower: number; tickUpper: number; liquidity: string; amount0Min?: string; amount1Min?: string }) =>
      wrap("remove-liquidity", params as unknown as Record<string, unknown>),
    [wrap]
  );

  const stakeFarm = useCallback(
    (params: StakeFarmParams) => wrap("stake", params as unknown as Record<string, unknown>),
    [wrap]
  );

  const claimFarm = useCallback(
    (params: { farmContract?: string; poolContract: string; tickLower: number; tickUpper: number }) =>
      wrap("claim", params as unknown as Record<string, unknown>),
    [wrap]
  );

  const unstakeFarm = useCallback(
    (params: {
      poolContract: string;
      tickLower: number;
      tickUpper: number;
      liquidity?: string;
      unstakeMax?: boolean;
    }) => wrap("unstake", params as unknown as Record<string, unknown>),
    [wrap]
  );

  const placeLimitOrder = useCallback(
    (params: {
      fromContract: string;
      toContract: string;
      amount: string;
      limitPrice: string;
      orderType?: string;
      expiryHours?: number;
    }) => wrap("limit-order", params as unknown as Record<string, unknown>),
    [wrap]
  );

  const cancelOrder = useCallback(
    (params: { orderId: string }) => wrap("cancel-order", params as unknown as Record<string, unknown>),
    [wrap]
  );

  const createPool = useCallback(
    (params: { token0Contract: string; token1Contract: string; feeTier?: string }) =>
      wrap("create-pool", params as unknown as Record<string, unknown>),
    [wrap]
  );

  return {
    executeSwap,
    addLiquidity,
    removeLiquidity,
    stakeFarm,
    claimFarm,
    unstakeFarm,
    placeLimitOrder,
    cancelOrder,
    createPool,
  };
}

/** Read pool state from API (which queries Soroban RPC) */
export async function getPoolState(poolContract: string) {
  const res = await fetch(`${BASE_URL}/pool-state?contract=${poolContract}`);
  if (!res.ok) return null;
  return res.json();
}

/** Get contract addresses from API */
export async function getContracts() {
  const res = await fetch(`${BASE_URL}/contracts`);
  if (!res.ok) return null;
  return res.json();
}
