import { eq } from "drizzle-orm";
import { getDb, isDatabaseEnabled, poolsTable, tokensTable } from "@workspace/db";
import {
  buildOnChainCatalog,
  type CatalogPool,
  type CatalogToken,
} from "./market-catalog.js";
import { listOnChainPools } from "./on-chain-pools.js";

function catalog() {
  return buildOnChainCatalog();
}

function mapDbToken(t: typeof tokensTable.$inferSelect): CatalogToken {
  return {
    ...t,
    price: parseFloat(t.price),
    change24h: parseFloat(t.change24h),
    volume24h: parseFloat(t.volume24h),
    createdAt: t.createdAt.toISOString(),
  };
}

async function mapDbPool(pool: typeof poolsTable.$inferSelect): Promise<CatalogPool> {
  const db = getDb();
  const [tokenA] = await db.select().from(tokensTable).where(eq(tokensTable.id, pool.tokenAId));
  const [tokenB] = await db.select().from(tokensTable).where(eq(tokensTable.id, pool.tokenBId));
  return {
    ...pool,
    reserveA: parseFloat(pool.reserveA),
    reserveB: parseFloat(pool.reserveB),
    totalLiquidity: parseFloat(pool.totalLiquidity),
    volume24h: parseFloat(pool.volume24h),
    fees24h: parseFloat(pool.fees24h),
    apy: parseFloat(pool.apy),
    fee: parseFloat(pool.fee),
    lpTokenSupply: parseFloat(pool.lpTokenSupply),
    createdAt: pool.createdAt.toISOString(),
    tokenA: mapDbToken(tokenA),
    tokenB: mapDbToken(tokenB),
  };
}

export function marketMode(): "database" | "onchain" {
  return isDatabaseEnabled() ? "database" : "onchain";
}

export async function listTokens(): Promise<CatalogToken[]> {
  if (!isDatabaseEnabled()) return catalog().tokens;
  const rows = await getDb().select().from(tokensTable).orderBy(tokensTable.id);
  return rows.map(mapDbToken);
}

export async function getTokenById(id: number): Promise<CatalogToken | null> {
  if (!isDatabaseEnabled()) {
    return catalog().tokens.find((t) => t.id === id) ?? null;
  }
  const [row] = await getDb().select().from(tokensTable).where(eq(tokensTable.id, id));
  return row ? mapDbToken(row) : null;
}

export async function listPools(): Promise<CatalogPool[]> {
  if (!isDatabaseEnabled()) return listOnChainPools();
  const rows = await getDb().select().from(poolsTable).orderBy(poolsTable.id);
  return Promise.all(rows.map(mapDbPool));
}

export async function getPoolById(id: number): Promise<CatalogPool | null> {
  if (!isDatabaseEnabled()) {
    const pools = await listOnChainPools();
    return pools.find((p) => p.id === id) ?? null;
  }
  const [row] = await getDb().select().from(poolsTable).where(eq(poolsTable.id, id));
  return row ? mapDbPool(row) : null;
}

export async function findPoolByTokenIds(
  tokenAId: number,
  tokenBId: number,
): Promise<CatalogPool | null> {
  const pools = await listPools();
  return (
    pools.find(
      (p) =>
        (p.tokenAId === tokenAId && p.tokenBId === tokenBId) ||
        (p.tokenAId === tokenBId && p.tokenBId === tokenAId),
    ) ?? null
  );
}
