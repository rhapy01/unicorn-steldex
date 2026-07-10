import { describe, expect, it } from "vitest";
import { findSwapRoute, isRoutableSwap, routeSymbols } from "./swap-route.js";
import type { OnChainPool } from "./pool-registry.js";
import type { ContractConfig } from "./contract-config.js";

const XLM = "C" + "X".repeat(55);
const PUSDC = "C" + "U".repeat(55);
const EURC = "C" + "E".repeat(55);
const STELLAR = "C" + "S".repeat(55);

function pool(
  address: string,
  token0: string,
  token1: string,
  symbol0: string,
  symbol1: string,
): OnChainPool {
  return {
    address,
    token0,
    token1,
    symbol0,
    symbol1,
    pair: `${symbol0}/${symbol1}`,
  };
}

describe("findSwapRoute", () => {
  const pools: OnChainPool[] = [
    pool("CP1", XLM, PUSDC, "XLM", "pUSDC"),
    pool("CP2", PUSDC, EURC, "pUSDC", "EURC"),
    pool("CP3", XLM, STELLAR, "XLM", "STELLAR"),
  ];

  it("returns direct hop when a pool exists", () => {
    const route = findSwapRoute(XLM, PUSDC, pools);
    expect(route).not.toBeNull();
    expect(route!.hops).toHaveLength(1);
    expect(route!.path).toEqual([XLM, PUSDC]);
  });

  it("finds a 2-hop path via hub", () => {
    const route = findSwapRoute(XLM, EURC, pools);
    expect(route).not.toBeNull();
    expect(route!.hops).toHaveLength(2);
    expect(route!.path).toEqual([XLM, PUSDC, EURC]);
  });

  it("returns null when disconnected", () => {
    const alone = "C" + "Z".repeat(55);
    expect(findSwapRoute(XLM, alone, pools)).toBeNull();
    expect(isRoutableSwap(XLM, alone, pools)).toBe(false);
  });

  it("labels route symbols", () => {
    const config = {
      tokens: { XLM, pUSDC: PUSDC, EURC, STELLAR },
    } as unknown as ContractConfig;
    expect(routeSymbols([XLM, PUSDC, EURC], config)).toEqual(["XLM", "pUSDC", "EURC"]);
  });
});
