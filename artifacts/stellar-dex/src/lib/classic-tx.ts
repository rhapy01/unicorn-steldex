import {
  Asset,
  Horizon,
  Operation,
  TransactionBuilder,
  type Horizon as HorizonTypes,
} from "@stellar/stellar-sdk";
import { CIRCLE_TESTNET_ISSUERS, type CircleStable } from "./circle-assets";

export const HORIZON_URL = "https://horizon-testnet.stellar.org";
const BASE_FEE = "100000";

export function accountHasTrustline(
  balances: HorizonTypes.HorizonApi.BalanceLine[],
  code: string,
  issuer: string
): boolean {
  return balances.some(
    (b) =>
      (b.asset_type === "credit_alphanum4" || b.asset_type === "credit_alphanum12") &&
      b.asset_code === code &&
      b.asset_issuer === issuer
  );
}

export function missingCircleTrustlines(
  balances: HorizonTypes.HorizonApi.BalanceLine[]
): CircleStable[] {
  return (Object.keys(CIRCLE_TESTNET_ISSUERS) as CircleStable[]).filter(
    (sym) => !accountHasTrustline(balances, sym, CIRCLE_TESTNET_ISSUERS[sym])
  );
}

/** Build, sign, and submit changeTrust for Circle USDC/EURC. */
export async function addCircleTrustlines(
  walletAddress: string,
  assets: CircleStable[],
  networkPassphrase: string,
  signTx: (xdr: string) => Promise<string>
): Promise<string> {
  const server = new Horizon.Server(HORIZON_URL);
  const account = await server.loadAccount(walletAddress);

  const toAdd = assets.filter(
    (sym) => !accountHasTrustline(account.balances, sym, CIRCLE_TESTNET_ISSUERS[sym])
  );
  if (toAdd.length === 0) {
    throw new Error("Trustlines already enabled");
  }

  let builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  });

  for (const sym of toAdd) {
    builder = builder.addOperation(
      Operation.changeTrust({
        asset: new Asset(sym, CIRCLE_TESTNET_ISSUERS[sym]),
      })
    );
  }

  const tx = builder.setTimeout(120).build();
  const signedXdr = await signTx(tx.toXDR());
  const signed = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);

  try {
    const result = await server.submitTransaction(signed);
    return result.hash;
  } catch (err: unknown) {
    const extras =
      err &&
      typeof err === "object" &&
      "response" in err &&
      err.response &&
      typeof err.response === "object" &&
      "data" in err.response
        ? (err.response as { data?: { detail?: string; extras?: { result_codes?: unknown } } }).data
        : undefined;
    const detail = extras?.detail;
    const codes = extras?.extras?.result_codes;
    if (detail) throw new Error(detail);
    if (codes) throw new Error(`Transaction failed: ${JSON.stringify(codes)}`);
    throw err;
  }
}
