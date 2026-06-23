import type { xdr } from "@stellar/stellar-sdk";

type StellarSdk = typeof import("@stellar/stellar-sdk");

/** Soroban contract enums are encoded as vec![Symbol(variant)]. */
export function feeTierScVal(StellarSdk: StellarSdk, tier: "Low" | "Medium" | "High") {
  return StellarSdk.xdr.ScVal.scvVec([StellarSdk.xdr.ScVal.scvSymbol(tier)]);
}

/** Build a sorted ScMap (required for Soroban struct decoding). */
export function scMap(
  StellarSdk: StellarSdk,
  entries: Array<[string, xdr.ScVal]>,
): xdr.ScVal {
  const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return StellarSdk.xdr.ScVal.scvMap(
    sorted.map(([key, val]) =>
      new StellarSdk.xdr.ScMapEntry({
        key: StellarSdk.xdr.ScVal.scvSymbol(key),
        val,
      }),
    ),
  );
}

export function addressScVal(StellarSdk: StellarSdk, id: string) {
  return new StellarSdk.Address(id).toScVal();
}
