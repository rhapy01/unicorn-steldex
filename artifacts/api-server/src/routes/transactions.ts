import { Router, type IRouter } from "express";
import { getDb, transactionsTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import {
  ListTransactionsQueryParams,
  ListTransactionsResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/transactions", async (req, res): Promise<void> => {
  const params = ListTransactionsQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  if (!process.env.DATABASE_URL) {
    res.json(ListTransactionsResponse.parse([]));
    return;
  }

  const db = getDb();
  let query = db.select().from(transactionsTable).$dynamic();

  if (params.data.walletAddress) {
    query = query.where(eq(transactionsTable.walletAddress, params.data.walletAddress));
  }
  if (params.data.type) {
    query = query.where(eq(transactionsTable.type, params.data.type));
  }

  const limit = params.data.limit ?? 50;
  const rows = await query.orderBy(desc(transactionsTable.createdAt)).limit(limit);

  const txs = rows.map((t) => ({
    ...t,
    amountA: parseFloat(t.amountA),
    amountB: parseFloat(t.amountB),
    valueUsd: t.valueUsd != null ? parseFloat(t.valueUsd) : null,
    timestamp: t.createdAt.toISOString(),
  }));

  res.json(ListTransactionsResponse.parse(txs));
});

export default router;
