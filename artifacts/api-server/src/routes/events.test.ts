import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../app";

describe("GET /api/stellar/events", () => {
  it("opens an SSE stream with connected event", async () => {
    const res = await request(app)
      .get("/api/stellar/events")
      .buffer(true)
      .parse((res, cb) => {
        const stream = res as unknown as import("node:http").IncomingMessage & { destroy?: () => void };
        let data = "";
        stream.on("data", (chunk: Buffer) => {
          data += chunk.toString();
          if (data.includes("connected")) {
            stream.destroy?.();
            cb(null, data);
          }
        });
        stream.on("error", () => cb(null, data));
      });

    expect(res.headers["content-type"]).toContain("text/event-stream");
    const body = typeof res.body === "string" ? res.body : String(res.body ?? "");
    expect(body).toContain('"type":"connected"');
  });
});
