/** Truncate a Stellar address for display (e.g. GABC...WXYZ). */
export function formatAddress(addr: string, chars = 4): string {
  if (!addr) return "";
  if (addr.length <= chars * 2 + 3) return addr;
  return `${addr.slice(0, chars)}...${addr.slice(-chars)}`;
}

/** Parse a human-readable token amount to smallest units. */
export function parseTokenAmount(amount: string, decimals: number): bigint {
  const trimmed = amount.trim();
  if (!trimmed || trimmed === ".") return 0n;
  const [whole, frac = ""] = trimmed.split(".");
  const paddedFrac = frac.padEnd(decimals, "0").slice(0, decimals);
  const combined = `${whole}${paddedFrac}`.replace(/^0+/, "") || "0";
  return BigInt(combined);
}

/** Format smallest units to a human-readable decimal string. */
export function formatTokenAmount(raw: bigint, decimals: number): string {
  const s = raw.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals) || "0";
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}
