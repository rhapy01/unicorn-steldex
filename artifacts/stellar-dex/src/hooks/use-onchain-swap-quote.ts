import { useQuery } from "@tanstack/react-query";

export type OnChainSwapQuote = {
  onChain: boolean;
  inputAmount: number;
  outputAmount: number;
  minimumReceived: number;
  executionPrice: number;
  priceImpact: number;
  fee: number;
  route: string[];
  amountOutRaw?: string;
  minAmountOutRaw?: string;
};

export function isPoolSwapPair(symbolA: string, symbolB: string): boolean {
  const set = new Set([symbolA, symbolB]);
  return set.has("XLM") && set.has("pUSDC");
}

async function fetchOnChainQuote(params: {
  walletAddress: string;
  fromTokenContract: string;
  toTokenContract: string;
  amountIn: string;
  slippageBps?: number;
}): Promise<OnChainSwapQuote> {
  const res = await fetch("/api/stellar/swap/quote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(String(err.error || `HTTP ${res.status}`));
  }
  return res.json();
}

export function useOnChainSwapQuote(params: {
  walletAddress?: string;
  fromTokenContract?: string | null;
  toTokenContract?: string | null;
  amountIn?: string;
  enabled?: boolean;
  slippageBps?: number;
}) {
  const {
    walletAddress,
    fromTokenContract,
    toTokenContract,
    amountIn,
    enabled = true,
    slippageBps = 50,
  } = params;

  return useQuery({
    queryKey: [
      "onchain-swap-quote",
      walletAddress,
      fromTokenContract,
      toTokenContract,
      amountIn,
      slippageBps,
    ],
    queryFn: () =>
      fetchOnChainQuote({
        walletAddress: walletAddress!,
        fromTokenContract: fromTokenContract!,
        toTokenContract: toTokenContract!,
        amountIn: amountIn!,
        slippageBps,
      }),
    enabled:
      enabled &&
      !!walletAddress &&
      !!fromTokenContract &&
      !!toTokenContract &&
      !!amountIn &&
      amountIn !== "0",
    staleTime: 10_000,
    retry: false,
  });
}
