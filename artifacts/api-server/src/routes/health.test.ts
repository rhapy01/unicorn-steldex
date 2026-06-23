import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../app";

describe("GET /api/healthz", () => {
  it("returns ok status", async () => {
    const res = await request(app).get("/api/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("GET /api/stellar/contracts", () => {
  it("returns network metadata", async () => {
    const res = await request(app).get("/api/stellar/contracts");
    expect(res.status).toBe(200);
    expect(res.body.network).toBe("testnet");
    expect(res.body.sorobanRpc).toContain("soroban-testnet");
    expect(res.body.contractsReady).toBe(false);
  });
});
