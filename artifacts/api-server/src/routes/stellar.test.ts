import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../app";

describe("GET /api/stellar/contracts", () => {
  it("returns contract config with contractsReady flag", async () => {
    const res = await request(app).get("/api/stellar/contracts");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("contractsReady");
    expect(res.body).toHaveProperty("tokens");
    expect(res.body.tokens.XLM).toBeDefined();
    expect(res.body.sorobanRpc).toContain("soroban");
  });
});

describe("POST /api/stellar/swap", () => {
  it("returns 503 when contracts are not configured", async () => {
    const res = await request(app)
      .post("/api/stellar/swap")
      .send({
        walletAddress: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
        fromTokenContract: "CTOKEN0",
        toTokenContract: "CTOKEN1",
        amountIn: "1000000",
      });

    expect(res.status).toBe(503);
    expect(res.body.error).toContain("contracts");
  });

  it("requires walletAddress", async () => {
    const res = await request(app).post("/api/stellar/swap").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("walletAddress");
  });
});

describe("POST /api/stellar/add-liquidity", () => {
  it("returns 503 when contracts are not configured", async () => {
    const res = await request(app)
      .post("/api/stellar/add-liquidity")
      .send({
        walletAddress: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
        token0Contract: "CTOKEN0",
        token1Contract: "CTOKEN1",
        amount0Desired: "1000000",
        amount1Desired: "1000000",
      });

    expect(res.status).toBe(503);
  });
});

describe("POST /api/stellar/limit-order", () => {
  it("returns 503 when contracts are not configured", async () => {
    const res = await request(app)
      .post("/api/stellar/limit-order")
      .send({
        walletAddress: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
        fromContract: "CTOKEN0",
        toContract: "CTOKEN1",
        amount: "5000000",
        limitPrice: "1300000",
      });

    expect(res.status).toBe(503);
  });

  it("requires walletAddress", async () => {
    const res = await request(app).post("/api/stellar/limit-order").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("walletAddress");
  });
});

describe("GET /api/stellar/pool-state", () => {
  it("returns 503 when contracts are not configured", async () => {
    const res = await request(app).get("/api/stellar/pool-state?contract=CPOOL");
    expect(res.status).toBe(503);
  });

  it("requires contract query param", async () => {
    const res = await request(app).get("/api/stellar/pool-state");
    expect(res.status).toBe(400);
  });
});
