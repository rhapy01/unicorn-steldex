import { getContractConfig } from "./contract-config.js";

const NOW = new Date().toISOString();
const USDC_LOGO = "https://cryptologos.cc/logos/usd-coin-usdc-logo.png";

export type CatalogToken = {
  id: number;
  symbol: string;
  name: string;
  price: number;
  change24h: number;
  volume24h: number;
  logoUrl: string;
  contractAddress: string | null;
  isNative: boolean;
  createdAt: string;
};

export type CatalogPool = {
  id: number;
  tokenAId: number;
  tokenBId: number;
  reserveA: number;
  reserveB: number;
  totalLiquidity: number;
  volume24h: number;
  fees24h: number;
  apy: number;
  fee: number;
  lpTokenSupply: number;
  createdAt: string;
  tokenA: CatalogToken;
  tokenB: CatalogToken;
  /** Soroban pool contract (on-chain mode). */
  poolContract?: string;
  pair?: string;
};

function tokenRow(
  id: number,
  symbol: string,
  name: string,
  price: number,
  opts: {
    change24h?: number;
    volume24h?: number;
    logoUrl: string;
    isNative?: boolean;
    contractAddress?: string | null;
  },
): CatalogToken {
  return {
    id,
    symbol,
    name,
    price,
    change24h: opts.change24h ?? 0,
    volume24h: opts.volume24h ?? 0,
    logoUrl: opts.logoUrl,
    isNative: opts.isNative ?? false,
    contractAddress: opts.contractAddress ?? null,
    createdAt: NOW,
  };
}

/** Static catalog for on-chain mode (no Postgres). Addresses come from `.env.contracts`. */
export function buildOnChainCatalog(): { tokens: CatalogToken[]; pools: CatalogPool[] } {
  const config = getContractConfig();
  const tokens: CatalogToken[] = [
    tokenRow(1, "XLM", "Stellar Lumens", 0.13, {
      change24h: 2.4,
      volume24h: 12_500_000,
      logoUrl: "https://cryptologos.cc/logos/stellar-xlm-logo.png",
      isNative: true,
      contractAddress: config.tokens.XLM ?? null,
    }),
    tokenRow(2, "pUSDC", "Pool USD Coin (DEX)", 1.0, {
      change24h: 0.01,
      volume24h: 8_900_000,
      logoUrl: USDC_LOGO,
      contractAddress: config.poolUsdc || config.tokens.pUSDC || null,
    }),
    tokenRow(3, "cUSDC", "Circle USD Coin", 1.0, {
      change24h: 0.01,
      volume24h: 6_500_000,
      logoUrl: USDC_LOGO,
      contractAddress: config.circleUsdc || config.tokens.cUSDC || null,
    }),
    tokenRow(4, "EURC", "Euro Coin (Circle)", 1.08, {
      change24h: 0.02,
      volume24h: 1_200_000,
      logoUrl: "https://cryptologos.cc/logos/euro-coin-eurc-logo.png",
      contractAddress: config.circleEurc || config.tokens.EURC || null,
    }),
    tokenRow(5, "STELLAR", "StellarSwap reward", 0.05, {
      volume24h: 50_000,
      logoUrl: "https://cryptologos.cc/logos/stellar-xlm-logo.png",
      contractAddress: config.tokens.STELLAR ?? null,
    }),
  ];

  const xlm = tokens[0];
  const pUsdc = tokens[1];
  const pools: CatalogPool[] = [];

  if (config.contractsReady && config.pool) {
    pools.push({
      id: 1,
      tokenAId: xlm.id,
      tokenBId: pUsdc.id,
      reserveA: 0,
      reserveB: 0,
      totalLiquidity: 0,
      volume24h: 0,
      fees24h: 0,
      apy: 0,
      fee: 0.003,
      lpTokenSupply: 0,
      createdAt: NOW,
      tokenA: xlm,
      tokenB: pUsdc,
    });
  }

  return { tokens, pools };
}
