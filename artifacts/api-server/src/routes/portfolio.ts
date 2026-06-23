import { Router, type IRouter } from "express";
import { getDb, transactionsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import {
  GetPortfolioQueryParams,
  GetPortfolioResponse,
} from "@workspace/api-zod";
import { listTokens, marketMode } from "../lib/market-store.js";
import { getOnChainPortfolio } from "../lib/on-chain-portfolio.js";

const router: IRouter = Router();

router.get("/portfolio", async (req, res): Promise<void> => {
  const params = GetPortfolioQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const { walletAddress } = params.data;

  if (marketMode() === "onchain") {
    try {
      const portfolio = await getOnChainPortfolio(walletAddress);
      res.json(portfolio);
    } catch (e: unknown) {
      res.status(503).json({
        error: `Portfolio load failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    return;
  }

  const db = getDb();
  const txs = await db
    .select()
    .from(transactionsTable)
    .where(eq(transactionsTable.walletAddress, walletAddress))
    .orderBy(desc(transactionsTable.createdAt))
    .limit(20);

  const recentTransactions = txs.map((t) => ({
    ...t,
    amountA: parseFloat(t.amountA),
    amountB: parseFloat(t.amountB),
    valueUsd: t.valueUsd != null ? parseFloat(t.valueUsd) : null,
    timestamp: t.createdAt.toISOString(),
  }));

  const tokens = await listTokens();
  const tokenBalances = tokens.slice(0, 4).map((t) => ({
    symbol: t.symbol,
    name: t.name,
    balance: 0,
    valueUsd: 0,
    price: t.price,
    change24h: t.change24h,
    logoUrl: t.logoUrl,
  }));

  res.json(GetPortfolioResponse.parse({
    walletAddress,
    totalValueUsd: 0,
    tokenBalances,
    lpPositions: [],
    recentTransactions,
  }));
});

export default router;
