import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useWallet } from "./use-wallet";
import { addCircleTrustlines } from "@/lib/classic-tx";
import { CIRCLE_STABLES, type CircleStable } from "@/lib/circle-assets";

export function useAddCircleTrustlines() {
  const { address, signTx, networkPassphrase } = useWallet();
  const queryClient = useQueryClient();
  const [isAdding, setIsAdding] = useState(false);

  const addTrustlines = useCallback(
    async (assets: CircleStable[] = CIRCLE_STABLES) => {
      if (!address) throw new Error("Connect wallet first");
      setIsAdding(true);
      try {
        const hash = await addCircleTrustlines(address, assets, networkPassphrase, signTx);
        await queryClient.invalidateQueries({ queryKey: ["wallet-balances", address] });
        return hash;
      } finally {
        setIsAdding(false);
      }
    },
    [address, networkPassphrase, queryClient, signTx]
  );

  return { addTrustlines, isAdding };
}
