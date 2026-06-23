import { useQuery } from "@tanstack/react-query";

export type StellarContractsConfig = {
  factory: string | null;
  router: string | null;
  farm: string | null;
  orders: string | null;
  pool: string | null;
  contractsReady: boolean;
  sorobanRpc: string;
  networkPassphrase: string;
  network: string;
  tokens: Record<string, string>;
  pools: Array<{ pair: string; contract: string }>;
};

export function useContracts() {
  return useQuery<StellarContractsConfig>({
    queryKey: ["stellar-contracts"],
    queryFn: async () => {
      const res = await fetch("/api/stellar/contracts");
      if (!res.ok) throw new Error("Failed to load contract config");
      return res.json();
    },
    staleTime: 60_000,
  });
}
