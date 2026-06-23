import { Router, type IRouter } from "express";
import { getDb, poolsTable, transactionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  GetPoolParams,
  ListPoolsQueryParams,
  ListPoolsResponse,
  GetPoolResponse,
  CreatePoolBody,
  AddLiquidityParams,
  AddLiquidityBody,
  AddLiquidityResponse,
  RemoveLiquidityParams,
  RemoveLiquidityBody,
  RemoveLiquidityResponse,
} from "@workspace/api-zod";
import { getPoolById, listPools, marketMode } from "../lib/market-store.js";

const router: IRouter = Router();

router.get("/pools", async (req, res): Promise<void> => {
  const params = ListPoolsQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const pools = await listPools();
  if (marketMode() === "onchain") {
    res.json(pools);
    return;
  }
  res.json(ListPoolsResponse.parse(pools));
});

router.post("/pools", async (req, res): Promise<void> => {
  if (marketMode() === "onchain") {
    res.status(501).json({ error: "Create pool on-chain via Soroban factory, not this API." });
    return;
  }

  const parsed = CreatePoolBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const db = getDb();
  const [pool] = await db.insert(poolsTable).values({
    tokenAId: parsed.data.tokenAId,
    tokenBId: parsed.data.tokenBId,
    fee: parsed.data.fee.toString(),
  }).returning();

  const full = await getPoolById(pool.id);
  res.status(201).json(GetPoolResponse.parse(full));
});

router.get("/pools/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetPoolParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const pool = await getPoolById(params.data.id);
  if (!pool) {
    res.status(404).json({ error: "Pool not found" });
    return;
  }

  res.json(GetPoolResponse.parse(pool));
});

router.post("/pools/:id/liquidity", async (req, res): Promise<void> => {
  if (marketMode() === "onchain") {
    res.status(501).json({
      error: "Use on-chain liquidity: POST /api/stellar/add-liquidity and sign with Freighter.",
    });
    return;
  }

  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const idParam = AddLiquidityParams.safeParse({ id: parseInt(rawId, 10) });
  if (!idParam.success) {
    res.status(400).json({ error: idParam.error.message });
    return;
  }

  const parsed = AddLiquidityBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const pool = await getPoolById(idParam.data.id);
  if (!pool) {
    res.status(404).json({ error: "Pool not found" });
    return;
  }

  const tokenA = pool.tokenA;
  const tokenB = pool.tokenB;
  const db = getDb();

  const newReserveA = pool.reserveA + parsed.data.amountA;
  const newReserveB = pool.reserveB + parsed.data.amountB;
  const newTvl = newReserveA * tokenA.price + newReserveB * tokenB.price;

  const lpSupply = pool.lpTokenSupply;
  let lpTokensIssued: number;
  if (lpSupply === 0) {
    lpTokensIssued = Math.sqrt(parsed.data.amountA * parsed.data.amountB);
  } else {
    lpTokensIssued = Math.min(
      (parsed.data.amountA / pool.reserveA) * lpSupply,
      (parsed.data.amountB / pool.reserveB) * lpSupply,
    );
  }

  await db.update(poolsTable).set({
    reserveA: newReserveA.toString(),
    reserveB: newReserveB.toString(),
    totalLiquidity: newTvl.toString(),
    lpTokenSupply: (lpSupply + lpTokensIssued).toString(),
  }).where(eq(poolsTable.id, idParam.data.id));

  const txHash = "T" + Math.random().toString(36).substring(2, 18).toUpperCase();
  await db.insert(transactionsTable).values({
    type: "add_liquidity",
    walletAddress: parsed.data.walletAddress,
    tokenASymbol: tokenA.symbol,
    tokenBSymbol: tokenB.symbol,
    amountA: parsed.data.amountA.toString(),
    amountB: parsed.data.amountB.toString(),
    txHash,
    status: "confirmed",
    valueUsd: (parsed.data.amountA * tokenA.price + parsed.data.amountB * tokenB.price).toString(),
  });

  res.json(AddLiquidityResponse.parse({
    success: true,
    txHash,
    lpTokenAmount: lpTokensIssued,
    amountA: parsed.data.amountA,
    amountB: parsed.data.amountB,
  }));
});

router.delete("/pools/:id/liquidity", async (req, res): Promise<void> => {
  if (marketMode() === "onchain") {
    res.status(501).json({ error: "Remove liquidity on-chain via pool contract." });
    return;
  }

  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const idParam = RemoveLiquidityParams.safeParse({ id: parseInt(rawId, 10) });
  if (!idParam.success) {
    res.status(400).json({ error: idParam.error.message });
    return;
  }

  const parsed = RemoveLiquidityBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const pool = await getPoolById(idParam.data.id);
  if (!pool) {
    res.status(404).json({ error: "Pool not found" });
    return;
  }

  const db = getDb();
  const tokenA = pool.tokenA;
  const tokenB = pool.tokenB;
  const share = parsed.data.lpTokenAmount / pool.lpTokenSupply;
  const amountA = pool.reserveA * share;
  const amountB = pool.reserveB * share;

  await db.update(poolsTable).set({
    reserveA: (pool.reserveA - amountA).toString(),
    reserveB: (pool.reserveB - amountB).toString(),
    totalLiquidity: ((pool.reserveA - amountA) * tokenA.price + (pool.reserveB - amountB) * tokenB.price).toString(),
    lpTokenSupply: (pool.lpTokenSupply - parsed.data.lpTokenAmount).toString(),
  }).where(eq(poolsTable.id, idParam.data.id));

  const txHash = "T" + Math.random().toString(36).substring(2, 18).toUpperCase();
  await db.insert(transactionsTable).values({
    type: "remove_liquidity",
    walletAddress: parsed.data.walletAddress,
    tokenASymbol: tokenA.symbol,
    tokenBSymbol: tokenB.symbol,
    amountA: amountA.toString(),
    amountB: amountB.toString(),
    txHash,
    status: "confirmed",
    valueUsd: (amountA * tokenA.price + amountB * tokenB.price).toString(),
  });

  res.json(RemoveLiquidityResponse.parse({
    success: true,
    txHash,
    amountA,
    amountB,
    lpTokenAmount: parsed.data.lpTokenAmount,
  }));
});

export default router;
