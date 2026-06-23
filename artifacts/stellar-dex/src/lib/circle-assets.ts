/**
 * Circle testnet on Stellar — classic issuers (G...) and Soroban SAC contracts (C...).
 * Classic + SAC are the same asset; pools/swaps use the C... SAC address.
 */
export const CIRCLE_TESTNET_ISSUERS = {
  USDC: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  EURC: "GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO",
} as const;

export const CIRCLE_SAC_CONTRACTS = {
  USDC: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  EURC: "CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ",
} as const;

/** Native XLM Soroban contract (official — not a custom token). */
export const NATIVE_XLM_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

export type CircleStable = keyof typeof CIRCLE_TESTNET_ISSUERS;

export const CIRCLE_STABLES: CircleStable[] = ["USDC", "EURC"];

export const CIRCLE_FAUCET_URL = "https://faucet.circle.com/";

/** UI symbol → classic trustline asset code. */
export function circleStableForSymbol(symbol: string): CircleStable | null {
  if (symbol === "cUSDC") return "USDC";
  if (symbol === "EURC") return "EURC";
  return null;
}

/** Trustlines required before swapping or receiving Circle SAC tokens. */
export function circleTrustlinesNeeded(
  tokenSymbols: string[],
  hasTrustline: Record<CircleStable, boolean>,
): CircleStable[] {
  const needed = new Set<CircleStable>();
  for (const sym of tokenSymbols) {
    const stable = circleStableForSymbol(sym);
    if (stable && !hasTrustline[stable]) needed.add(stable);
  }
  return [...needed];
}
