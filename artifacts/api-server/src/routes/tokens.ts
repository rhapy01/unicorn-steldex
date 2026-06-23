import { Router, type IRouter } from "express";
import {
  GetTokenParams,
  ListTokensResponse,
  GetTokenResponse,
} from "@workspace/api-zod";
import { listTokens, getTokenById } from "../lib/market-store.js";

const router: IRouter = Router();

router.get("/tokens", async (_req, res): Promise<void> => {
  const tokens = await listTokens();
  res.json(ListTokensResponse.parse(tokens));
});

router.get("/tokens/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetTokenParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const row = await getTokenById(params.data.id);
  if (!row) {
    res.status(404).json({ error: "Token not found" });
    return;
  }
  res.json(GetTokenResponse.parse(row));
});

export default router;
