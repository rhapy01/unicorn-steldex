import { useQuery } from "@tanstack/react-query";

export type OnChainOrder = {
  id: string;
  owner: string;
  poolContract: string;
  fromSymbol: string;
  toSymbol: string;
  fromAmount: string;
  toAmountMin: string;
  limitPrice: number;
  currentPrice: number;
  orderType: string;
  status: "pending" | "filled" | "expired" | "cancelled";
  createdAt: string;
  expiryLedger: number;
  expiresInLedgers: number;
  fillPercent: number;
  zeroForOne: boolean;
};

export type OrderBookData = {
  sells: Array<{
    price: number;
    amount: number;
    total: number;
    orderId: string;
    orderCount: number;
    cumulative: number;
  }>;
  buys: Array<{
    price: number;
    amount: number;
    total: number;
    orderId: string;
    orderCount: number;
    cumulative: number;
  }>;
  spread: number;
  currentPrice: number;
  sellDepth: number;
  buyDepth: number;
};

export function useWalletOrders(wallet?: string | null) {
  return useQuery<OnChainOrder[]>({
    queryKey: ["limit-orders", wallet],
    queryFn: async () => {
      const res = await fetch(`/api/stellar/orders?wallet=${encodeURIComponent(wallet!)}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      return res.json();
    },
    enabled: !!wallet,
    refetchInterval: 10_000,
  });
}

export function useOrderBook(poolContract?: string, fromSymbol = "XLM", toSymbol = "pUSDC") {
  return useQuery<OrderBookData>({
    queryKey: ["order-book", poolContract, fromSymbol, toSymbol],
    queryFn: async () => {
      const q = new URLSearchParams({
        pool: poolContract!,
        from: fromSymbol,
        to: toSymbol,
      });
      const res = await fetch(`/api/stellar/order-book?${q}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      return res.json();
    },
    enabled: !!poolContract,
    refetchInterval: 10_000,
  });
}
