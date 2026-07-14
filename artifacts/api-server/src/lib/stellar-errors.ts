import type { Response } from "express";

export function toI128String(value: string | undefined): bigint {
  const v = (value ?? "0").trim();
  if (!/^\d+$/.test(v)) {
    throw new Error(`Invalid amount "${v}" — expected integer string in smallest token units`);
  }
  return BigInt(v);
}

export function sendStellarError(
  res: Response,
  err: unknown,
  ctx?: { wallet?: string; operation?: "swap" | "quote" | "liquidity" | "limit-order" | "cancel-order" | "create-pool" },
): void {
  const raw = err instanceof Error ? err.message : String(err);

  if (raw.includes("Account not found")) {
    const fundUrl = ctx?.wallet
      ? `https://friendbot.stellar.org?addr=${encodeURIComponent(ctx.wallet)}`
      : "https://laboratory.stellar.org/#account-creator?network=testnet";
    res.status(400).json({
      error: `Wallet not activated on Stellar testnet. Fund it first: ${fundUrl}`,
    });
    return;
  }

  if (raw.includes("invalid encoded string") || raw.includes("Unsupported address type")) {
    res.status(400).json({ error: "Invalid Stellar address (wallet or token contract)." });
    return;
  }

  if (raw.includes("Invalid amount")) {
    res.status(400).json({ error: raw });
    return;
  }

  if (raw.startsWith("Insufficient ")) {
    res.status(422).json({ error: raw });
    return;
  }

  if (raw.includes("swap_exact_input") && raw.includes("insufficient output")) {
    res.status(422).json({
      error:
        "Swap would return less than your minimum (slippage too low or amount too large for pool liquidity). Try a smaller amount or add liquidity on Pools.",
    });
    return;
  }

  if (raw.includes("swap_exact_input") && raw.includes("UnreachableCodeReached")) {
    res.status(422).json({
      error:
        "Swap simulation failed. Ensure the pool has liquidity and you have wrapped XLM / pUSDC balance.",
    });
    return;
  }

  if (raw.includes("zero liquidity") || raw.includes("Computed zero liquidity")) {
    res.status(422).json({
      error:
        "Liquidity amount computed as zero. Increase both token amounts (need Soroban USDC and wrapped XLM).",
    });
    return;
  }

  if (
    raw.includes("transfer_from") ||
    raw.includes("insufficient balance") ||
    raw.includes("insufficient allowance")
  ) {
    const op = ctx?.operation;
    if (op === "swap" || op === "quote") {
      res.status(422).json({
        error:
          "Insufficient balance for this swap. For XLM, keep ~1 XLM for fees — wrapping happens in step 1. For cUSDC/EURC, fund your wallet first. Then retry; Freighter will ask you to approve the pool.",
      });
      return;
    }
    if (op === "liquidity") {
      res.status(422).json({
        error:
          "Insufficient balance or allowance for add liquidity. Fund both pool tokens in your wallet (wrap XLM if needed), sign each Freighter step in order, and approve the pool for both tokens.",
      });
      return;
    }
    res.status(422).json({
      error:
        "Insufficient token balance or allowance. Check wallet balances for the pool tokens and approve the pool contract.",
    });
    return;
  }

  if (raw.includes("add_liquidity")) {
    res.status(422).json({
      error:
        "Add liquidity failed. Pools use Soroban tokens (pUSDC, wrapped XLM, cUSDC SAC, EURC SAC). Fund your wallet with the correct token before adding liquidity.",
    });
    return;
  }

  if (
    raw.includes("trustline") ||
    raw.includes("does not accept the asset") ||
    raw.includes("op_no_trust")
  ) {
    res.status(422).json({
      error:
        "Your wallet must enable a trustline for cUSDC or EURC before receiving Circle tokens. On Swap, click “Enable USDC + EURC” (or swap will prompt you), approve in Freighter, then retry.",
    });
    return;
  }

  if (raw.includes("pool not found")) {
    res.status(422).json({
      error: "Pool not found for this token pair. Token order or contract addresses may be wrong.",
    });
    return;
  }

  if (raw.includes("HostError") || raw.toLowerCase().includes("simulation")) {
    res.status(422).json({ error: raw });
    return;
  }

  res.status(500).json({ error: raw });
}
