import { describe, it, expect } from "vitest";
import { formatAddress, parseTokenAmount, formatTokenAmount } from "./format";

describe("formatAddress", () => {
  it("truncates long addresses", () => {
    expect(formatAddress("GABCDEFGHIJKLMNOPQRSTUVWXYZ123456")).toBe("GABC...3456");
  });

  it("returns empty string for empty input", () => {
    expect(formatAddress("")).toBe("");
  });

  it("returns short addresses unchanged", () => {
    expect(formatAddress("GABC")).toBe("GABC");
  });
});

describe("parseTokenAmount", () => {
  it("parses whole numbers", () => {
    expect(parseTokenAmount("100", 7)).toBe(1000000000n);
  });

  it("parses decimal amounts", () => {
    expect(parseTokenAmount("1.5", 7)).toBe(15000000n);
  });

  it("returns zero for empty input", () => {
    expect(parseTokenAmount("", 7)).toBe(0n);
  });
});

describe("formatTokenAmount", () => {
  it("formats with decimals", () => {
    expect(formatTokenAmount(15000000n, 7)).toBe("1.5");
  });

  it("formats whole numbers without trailing zeros", () => {
    expect(formatTokenAmount(1000000000n, 7)).toBe("100");
  });
});
