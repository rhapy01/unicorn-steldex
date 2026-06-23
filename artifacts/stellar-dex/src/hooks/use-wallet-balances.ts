import { useQuery } from "@tanstack/react-query";
import {
  Address,
  Contract,
  Horizon,
  Networks,
  rpc,
  scValToBigInt,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import type { ContractsShape } from "@/lib/onchain";
import { tokenDecimals } from "@/lib/onchain";
import { CIRCLE_TESTNET_ISSUERS, type CircleStable } from "@/lib/circle-assets";
import { accountHasTrustline } from "@/lib/classic-tx";

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const SOROBAN_RPC = "https://soroban-testnet.stellar.org";

export { CIRCLE_TESTNET_ISSUERS } from "@/lib/circle-assets";

/** Public funded testnet account for read-only Soroban simulations. */
const SIM_SOURCE = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";

export type WalletBalances = {
  nativeXlm: number;
  bySymbol: Record<string, number>;
  hasTrustline: Record<CircleStable, boolean>;
};

async function fetchSorobanBalance(contractId: string, owner: string): Promise<bigint> {
  const server = new rpc.Server(SOROBAN_RPC);
  const contract = new Contract(contractId);
  let account;
  try {
    account = await server.getAccount(SIM_SOURCE);
  } catch {
    return 0n;
  }

  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(contract.call("balance", new Address(owner).toScVal()))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) return 0n;
  const val = sim.result?.retval;
  return val ? scValToBigInt(val) : 0n;
}

async function resolveBalances(
  address: string,
  contracts?: ContractsShape | null
): Promise<WalletBalances> {
  const server = new Horizon.Server(HORIZON_URL);
  const bySymbol: Record<string, number> = {};
  let nativeXlm = 0;
  let hasTrustline: Record<CircleStable, boolean> = { USDC: false, EURC: false };

  try {
    const account = await server.loadAccount(address);
    hasTrustline = {
      USDC: accountHasTrustline(account.balances, "USDC", CIRCLE_TESTNET_ISSUERS.USDC),
      EURC: accountHasTrustline(account.balances, "EURC", CIRCLE_TESTNET_ISSUERS.EURC),
    };
    for (const b of account.balances) {
      if (b.asset_type === "native") {
        nativeXlm = parseFloat(b.balance);
        bySymbol.XLM = nativeXlm;
      } else if (b.asset_type === "credit_alphanum4" || b.asset_type === "credit_alphanum12") {
        const bal = parseFloat(b.balance);
        const issuer = b.asset_issuer;
        // Circle USDC/EURC trustline balance == Soroban SAC balance — loaded below, not here.
        if (b.asset_code === "USDC" && issuer === CIRCLE_TESTNET_ISSUERS.USDC) continue;
        if (b.asset_code === "EURC" && issuer === CIRCLE_TESTNET_ISSUERS.EURC) continue;
        bySymbol[b.asset_code] = (bySymbol[b.asset_code] ?? 0) + bal;
      }
    }
  } catch {
    // Account not found or horizon unreachable
  }

  if (contracts?.tokens) {
    for (const [symbol, contractId] of Object.entries(contracts.tokens)) {
      if (!contractId || symbol === "XLM") continue;
      const raw = await fetchSorobanBalance(contractId, address);
      const decimals = tokenDecimals(symbol);
      const human = Number(raw) / 10 ** decimals;
      bySymbol[symbol] = human;
    }
  }

  // Native XLM only — do not add wrapped SAC balance (same funds, double-counts in UI).
  bySymbol.XLM = nativeXlm;

  return { nativeXlm, bySymbol, hasTrustline };
}

export function formatBalanceDisplay(balance: number | undefined): string {
  if (balance === undefined || balance === 0) return "0";
  if (balance < 0.0001) return balance.toExponential(2);
  return balance.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

export function useWalletBalances(
  address: string | null,
  contracts?: ContractsShape | null
) {
  return useQuery({
    queryKey: ["wallet-balances", address, contracts?.tokens],
    queryFn: () => resolveBalances(address!, contracts),
    enabled: !!address,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}
