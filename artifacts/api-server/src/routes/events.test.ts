import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../app";

describe("GET /api/stellar/events", () => {
  it("opens an SSE stream with connected event", async () => {
    const res = await request(app)
      .get("/api/stellar/events")
      .buffer(true)
      .parse((res, cb) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
          if (data.includes("connected")) {
            res.destroy();
            cb(null, data);
          }
        });
        res.on("error", () => cb(null, data));
      });

    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.text).toContain('"type":"connected"');
  });
});
