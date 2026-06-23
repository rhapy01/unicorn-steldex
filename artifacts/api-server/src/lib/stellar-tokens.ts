/**
 * Official Stellar testnet assets (Soroban Stellar Asset Contracts + classic issuers).
 * Circle USDC/EURC for trustlines and faucet balances. The XLM/USDC pool uses
 * USDC_TOKEN_CONTRACT (custom deploy) from .env.contracts — see poolUsdc in GET /contracts.
 */
export const OFFICIAL_TESTNET_TOKENS = {
  /** Native XLM on Soroban (wraps classic XLM balance). */
  XLM: {
    symbol: "XLM",
    decimals: 7,
    sacContract: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    classicIssuer: null as string | null,
  },
  /** Circle USDC — classic trustline + Soroban SAC are the same asset. */
  USDC: {
    symbol: "USDC",
    decimals: 7,
    sacContract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    classicIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  },
  /** Circle EURC — classic trustline + Soroban SAC. */
  EURC: {
    symbol: "EURC",
    decimals: 7,
    sacContract: "CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ",
    classicIssuer: "GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO",
  },
} as const;
