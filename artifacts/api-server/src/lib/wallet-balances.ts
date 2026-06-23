import { getContractConfig } from "./contract-config.js";
import { simulateContractBalance } from "./soroban-balance.js";
import { decimalsForSymbol } from "./token-decimals.js";

const HORIZON_URL = "https://horizon-testnet.stellar.org";

/** Live wallet balances by catalog symbol (native XLM + Soroban SAC / pool tokens). */
export async function resolveWalletBalances(
  address: string,
): Promise<Record<string, number>> {
  const StellarSdk = await import("@stellar/stellar-sdk");
  const horizon = new StellarSdk.Horizon.Server(HORIZON_URL);
  const config = getContractConfig();
  const bySymbol: Record<string, number> = {};
  let nativeXlm = 0;

  try {
    const account = await horizon.loadAccount(address);
    for (const b of account.balances) {
      if (b.asset_type === "native") {
        nativeXlm = parseFloat(b.balance);
      }
    }
  } catch {
    nativeXlm = 0;
  }

  bySymbol.XLM = nativeXlm;

  const rpc = new StellarSdk.rpc.Server("https://soroban-testnet.stellar.org");
  const entries = Object.entries(config.tokens).filter(
    ([symbol, contractId]) => contractId && symbol !== "XLM",
  );
  const balances = await Promise.all(
    entries.map(async ([symbol, contractId]) => {
      const raw = await simulateContractBalance(StellarSdk, rpc, contractId!, address);
      return [symbol, Number(raw) / 10 ** decimalsForSymbol(symbol)] as const;
    }),
  );
  for (const [symbol, bal] of balances) {
    bySymbol[symbol] = bal;
  }

  return bySymbol;
}
