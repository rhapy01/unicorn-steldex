import { Router, type IRouter } from "express";
import { getDb, poolsTable, transactionsTable, priceHistoryTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  GetSwapQuoteQueryParams,
  GetSwapQuoteResponse,
  ExecuteSwapBody,
  ExecuteSwapResponse,
} from "@workspace/api-zod";
import { findPoolByTokenIds, getTokenById, marketMode } from "../lib/market-store.js";

const router: IRouter = Router();

function getAmountOut(amountIn: number, reserveIn: number, reserveOut: number, fee: number): number {
  const amountInWithFee = amountIn * (1 - fee);
  if (reserveIn <= 0 || reserveOut <= 0) {
    return amountInWithFee;
  }
  return (amountInWithFee * reserveOut) / (reserveIn + amountInWithFee);
}

function getPriceImpact(amountIn: number, reserveIn: number): number {
  if (reserveIn <= 0) return 0;
  return (amountIn / (reserveIn + amountIn)) * 100;
}

router.get("/swap/quote", async (req, res): Promise<void> => {
  const params = GetSwapQuoteQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const { fromTokenId, toTokenId, amount, slippage = 0.5 } = params.data;
  const inputAmount = parseFloat(amount);

  const fromToken = await getTokenById(fromTokenId);
  const toToken = await getTokenById(toTokenId);

  if (!fromToken || !toToken) {
    res.status(404).json({ error: "Token not found" });
    return;
  }

  const pool = await findPoolByTokenIds(fromTokenId, toTokenId);
  if (!pool) {
    res.status(400).json({ error: "No liquidity pool found for this pair" });
    return;
  }

  const isAtoB = pool.tokenAId === fromTokenId;
  const reserveIn = isAtoB ? pool.reserveA : pool.reserveB;
  const reserveOut = isAtoB ? pool.reserveB : pool.reserveA;
  const fee = pool.fee;

  const outputAmount = getAmountOut(inputAmount, reserveIn, reserveOut, fee);
  const priceImpact = getPriceImpact(inputAmount, reserveIn);
  const feeAmount = inputAmount * fee;
  const minimumReceived = outputAmount * (1 - slippage / 100);
  const executionPrice = inputAmount > 0 ? outputAmount / inputAmount : 0;

  res.json(GetSwapQuoteResponse.parse({
    fromToken,
    toToken,
    inputAmount,
    outputAmount,
    priceImpact,
    fee: feeAmount,
    minimumReceived,
    executionPrice,
    route: [fromToken.symbol, toToken.symbol],
  }));
});

router.post("/swap", async (req, res): Promise<void> => {
  if (marketMode() === "onchain") {
    res.status(501).json({
      error: "Demo swap disabled in on-chain mode. Sign swaps via Freighter using POST /api/stellar/swap.",
    });
    return;
  }

  const parsed = ExecuteSwapBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { fromTokenId, toTokenId, inputAmount, minOutputAmount, walletAddress, slippage = 0.5 } = parsed.data;
  const fromToken = await getTokenById(fromTokenId);
  const toToken = await getTokenById(toTokenId);

  if (!fromToken || !toToken) {
    res.status(404).json({ error: "Token not found" });
    return;
  }

  const pool = await findPoolByTokenIds(fromTokenId, toTokenId);
  if (!pool) {
    res.status(400).json({ error: "No liquidity pool found" });
    return;
  }

  const isAtoB = pool.tokenAId === fromTokenId;
  const reserveIn = isAtoB ? pool.reserveA : pool.reserveB;
  const reserveOut = isAtoB ? pool.reserveB : pool.reserveA;
  const fee = pool.fee;

  const outputAmount = getAmountOut(inputAmount, reserveIn, reserveOut, fee);

  if (outputAmount < minOutputAmount) {
    res.status(400).json({ error: "Slippage exceeded: output below minimum" });
    return;
  }

  const db = getDb();
  const newReserveIn = reserveIn + inputAmount;
  const newReserveOut = reserveOut - outputAmount;
  const feeAmount = inputAmount * fee;
  const fromPrice = fromToken.price;
  const newVolume = pool.volume24h + inputAmount * fromPrice;
  const newFees = pool.fees24h + feeAmount * fromPrice;

  await db.update(poolsTable).set({
    reserveA: isAtoB ? newReserveIn.toString() : newReserveOut.toString(),
    reserveB: isAtoB ? newReserveOut.toString() : newReserveIn.toString(),
    volume24h: newVolume.toString(),
    fees24h: newFees.toString(),
  }).where(eq(poolsTable.id, pool.id));

  const txHash = "T" + Math.random().toString(36).substring(2, 18).toUpperCase();
  const executionPrice = outputAmount / inputAmount;

  await db.insert(transactionsTable).values({
    type: "swap",
    walletAddress,
    tokenASymbol: fromToken.symbol,
    tokenBSymbol: toToken.symbol,
    amountA: inputAmount.toString(),
    amountB: outputAmount.toString(),
    txHash,
    status: "confirmed",
    valueUsd: (inputAmount * fromPrice).toString(),
  });

  await db.insert(priceHistoryTable).values({
    poolId: pool.id,
    price: executionPrice.toString(),
    volume: (inputAmount * fromPrice).toString(),
  });

  res.json(ExecuteSwapResponse.parse({
    success: true,
    txHash,
    inputAmount,
    outputAmount,
    executionPrice,
    fee: feeAmount,
  }));
});

export default router;
