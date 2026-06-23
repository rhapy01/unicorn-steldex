import { getDb, tokensTable, poolsTable } from "./index.js";

const XLM_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const EURC_SAC = "CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ";

const DEMO_TOKENS = [
  {
    symbol: "XLM",
    name: "Stellar Lumens",
    price: "0.13",
    change24h: "2.4",
    volume24h: "12500000",
    logoUrl: "https://cryptologos.cc/logos/stellar-xlm-logo.png",
    isNative: true,
    contractAddress: process.env.XLM_TOKEN_CONTRACT || XLM_SAC,
  },
  {
    symbol: "USDC",
    name: "USD Coin (DEX pool)",
    price: "1.00",
    change24h: "0.01",
    volume24h: "8900000",
    logoUrl: "https://cryptologos.cc/logos/usd-coin-usdc-logo.png",
    isNative: false,
    contractAddress: process.env.USDC_TOKEN_CONTRACT || USDC_SAC,
  },
  {
    symbol: "EURC",
    name: "Euro Coin (Circle)",
    price: "1.08",
    change24h: "0.02",
    volume24h: "1200000",
    logoUrl: "https://cryptologos.cc/logos/euro-coin-eurc-logo.png",
    isNative: false,
    contractAddress: process.env.EURC_TOKEN_CONTRACT || EURC_SAC,
  },
  {
    symbol: "BTC",
    name: "Bitcoin",
    price: "45000",
    change24h: "-1.2",
    volume24h: "5200000",
    logoUrl: "https://cryptologos.cc/logos/bitcoin-btc-logo.png",
    isNative: false,
    contractAddress: null,
  },
  {
    symbol: "ETH",
    name: "Ethereum",
    price: "3200",
    change24h: "3.1",
    volume24h: "4100000",
    logoUrl: "https://cryptologos.cc/logos/ethereum-eth-logo.png",
    isNative: false,
    contractAddress: null,
  },
] as const;

export async function seedDatabase(): Promise<void> {
  const db = getDb();
  const existing = await db.select({ id: tokensTable.id }).from(tokensTable).limit(1);
  if (existing.length > 0) {
    console.log("Database already seeded — skipping.");
    return;
  }

  const tokens = await db.insert(tokensTable).values([...DEMO_TOKENS]).returning();

  const bySymbol = Object.fromEntries(tokens.map((t) => [t.symbol, t.id]));

  await db.insert(poolsTable).values([
    {
      tokenAId: bySymbol.XLM,
      tokenBId: bySymbol.USDC,
      reserveA: "5000000",
      reserveB: "650000",
      totalLiquidity: "1240000",
      volume24h: "890000",
      fees24h: "2670",
      apy: "18.5",
      fee: "0.003",
      lpTokenSupply: "1000000",
    },
    {
      tokenAId: bySymbol.XLM,
      tokenBId: bySymbol.BTC,
      reserveA: "2000000",
      reserveB: "5.8",
      totalLiquidity: "820000",
      volume24h: "420000",
      fees24h: "1260",
      apy: "14.2",
      fee: "0.003",
      lpTokenSupply: "500000",
    },
    {
      tokenAId: bySymbol.USDC,
      tokenBId: bySymbol.ETH,
      reserveA: "1500000",
      reserveB: "468",
      totalLiquidity: "2100000",
      volume24h: "1200000",
      fees24h: "3600",
      apy: "22.8",
      fee: "0.003",
      lpTokenSupply: "800000",
    },
  ]);

  console.log(`Seeded ${tokens.length} tokens and 3 liquidity pools.`);
}
