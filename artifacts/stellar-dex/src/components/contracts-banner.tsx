import { useContracts } from "@/hooks/use-contracts";

export function ContractsBanner() {
  const { data, isLoading } = useContracts();

  if (isLoading || data?.contractsReady) return null;

  return (
    <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 text-[12px] text-amber-900 text-center">
      Soroban contracts not loaded — deploy with{" "}
      <code className="font-mono text-[11px]">pnpm --filter @workspace/scripts run deploy</code>{" "}
      and restart the API
    </div>
  );
}
