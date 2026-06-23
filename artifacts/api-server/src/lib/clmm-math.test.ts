import { describe, it, expect } from "vitest";
import { computeLiquidity, tickToSqrtQ32 } from "./clmm-math";

describe("computeLiquidity", () => {
  it("returns non-zero liquidity for typical testnet pool inputs", () => {
    const sqrtPrice = tickToSqrtQ32(-2000);
    const sqrtPa = tickToSqrtQ32(-443580);
    const sqrtPb = tickToSqrtQ32(443580);
    const amount0 = 2_000_000n;
    const amount1 = 20_000_000n;
    const liq = computeLiquidity(sqrtPrice, sqrtPa, sqrtPb, amount0, amount1);
    expect(liq).toBeGreaterThan(0n);
  });
});
