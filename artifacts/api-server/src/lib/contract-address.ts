import { StrKey } from "@stellar/stellar-sdk";

/** Normalize a Soroban contract id (hex or C... strkey) to strkey form. */
export function toContractStrkey(id: string): string {
  if (!id) return "";
  if (id.startsWith("C")) return id;
  return StrKey.encodeContract(Buffer.from(id, "hex"));
}
