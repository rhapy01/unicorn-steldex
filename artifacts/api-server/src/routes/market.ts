import { Router, type IRouter } from "express";
import { getDb, priceHistoryTable, transactionsTable } from "@workspace/db";
import { gte, count } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  GetMarketStatsResponse,
  GetPriceHistoryQueryParams,
  GetPriceHistoryResponse,
} from "@workspace/api-zod";
import { listPools, listTokens } from "../lib/market-store.js";

const router: IRouter = Router();

router.get("/market/stats", async (_req, res): Promise<void> => {
  const pools = await listPools();
  const tokens = await listTokens();

  const totalTvl = pools.reduce((s, p) => s + p.totalLiquidity, 0);
  const volume24h = pools.reduce((s, p) => s + p.volume24h, 0);

  let totalTransactions24h = 0;
  if (process.env.DATABASE_URL) {
    const db = getDb();
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const txCount = await db
      .select({ c: count() })
      .from(transactionsTable)
      .where(gte(transactionsTable.createdAt, oneDayAgo));
    totalTransactions24h = txCount[0]?.c ?? 0;
  }

  res.json(GetMarketStatsResponse.parse({
    totalTvl,
    volume24h,
    totalPools: pools.length,
    totalTransactions24h,
    tvlChange24h: 0,
    volumeChange24h: 0,
    topPools: pools.slice(0, 5),
    topTokens: [...tokens].sort((a, b) => b.volume24h - a.volume24h).slice(0, 5),
  }));
});

router.get("/market/price-history", async (req, res): Promise<void> => {
  const params = GetPriceHistoryQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  if (!process.env.DATABASE_URL) {
    res.json(GetPriceHistoryResponse.parse([]));
    return;
  }

  const { poolId, period = "24h" } = params.data;
  const periodMs: Record<string, number> = {
    "1h": 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000,
  };

  const since = new Date(Date.now() - (periodMs[period] ?? periodMs["24h"]));
  const db = getDb();
  const rows = await db
    .select()
    .from(priceHistoryTable)
    .where(
      sql`${priceHistoryTable.poolId} = ${poolId} AND ${priceHistoryTable.createdAt} >= ${since}`,
    )
    .orderBy(priceHistoryTable.createdAt);

  const points = rows.map((r) => ({
    timestamp: r.createdAt.toISOString(),
    price: parseFloat(r.price),
    volume: parseFloat(r.volume),
  }));

  res.json(GetPriceHistoryResponse.parse(points));
});

export default router;
