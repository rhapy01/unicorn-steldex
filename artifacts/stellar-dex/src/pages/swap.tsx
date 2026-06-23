import React, { useState, useEffect, useMemo } from "react";
import { useListTokens } from "@workspace/api-client-react";
import { useWallet } from "@/hooks/use-wallet";
import { useStellarContract } from "@/hooks/use-stellar";
import { useContracts } from "@/hooks/use-contracts";
import { formatBalanceDisplay, useWalletBalances } from "@/hooks/use-wallet-balances";
import { useAddCircleTrustlines } from "@/hooks/use-trustlines";
import { useOnChainSwapQuote } from "@/hooks/use-onchain-swap-quote";
import { CIRCLE_FAUCET_URL, circleTrustlinesNeeded } from "@/lib/circle-assets";
import { parseTokenAmount, resolveTokenContract, tokenDecimals } from "@/lib/onchain";
import { useToast } from "@/hooks/use-toast";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ChevronDown, Search } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import type { Token } from "@workspace/api-client-react/src/generated/api.schemas";

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);
  useEffect(() => {
    const handler = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(handler);
  }, [value, delay]);
  return debouncedValue;
}

function usdValue(amount: string, price: number): string {
  const n = parseFloat(amount);
  if (!n || n <= 0) return "$0";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n * price);
}

export default function Swap() {
  const { address, connect } = useWallet();
  const { toast } = useToast();

  const [fromAmount, setFromAmount] = useState("");
  const debouncedFromAmount = useDebounce(fromAmount, 500);
  const [fromTokenId, setFromTokenId] = useState<number | null>(null);
  const [toTokenId, setToTokenId] = useState<number | null>(null);
  const [selecting, setSelecting] = useState<"from" | "to" | null>(null);
  const [tokenSearch, setTokenSearch] = useState("");

  const { data: tokens, isLoading: isLoadingTokens } = useListTokens();

  useEffect(() => {
    if (tokens && tokens.length >= 2 && fromTokenId === null && toTokenId === null) {
      const xlm = tokens.find((t) => t.symbol === "XLM") ?? tokens[0];
      const poolUsdc = tokens.find((t) => t.symbol === "pUSDC") ?? tokens[1];
      setFromTokenId(xlm.id);
      setToTokenId(poolUsdc.id);
    }
  }, [tokens, fromTokenId, toTokenId]);

  const fromToken = tokens?.find((t) => t.id === fromTokenId);
  const toToken = tokens?.find((t) => t.id === toTokenId);

  const { executeSwap } = useStellarContract();
  const { data: contracts } = useContracts();

  const fromContract = fromToken ? resolveTokenContract(fromToken.symbol, contracts) : null;
  const toContract = toToken ? resolveTokenContract(toToken.symbol, contracts) : null;
  const hasContracts = !!fromContract && !!toContract;

  const amountInRaw =
    fromToken && debouncedFromAmount && parseFloat(debouncedFromAmount) > 0
      ? parseTokenAmount(debouncedFromAmount, tokenDecimals(fromToken.symbol)).toString()
      : undefined;

  const {
    data: onChainQuote,
    isLoading: isOnChainQuoting,
    error: onChainQuoteError,
  } = useOnChainSwapQuote({
    walletAddress: address ?? undefined,
    fromTokenContract: fromContract,
    toTokenContract: toContract,
    amountIn: amountInRaw,
    enabled: hasContracts && !!address && !!amountInRaw,
  });

  const isQuoting = hasContracts && isOnChainQuoting;
  const quote = hasContracts ? onChainQuote : null;
  const pairUnsupported = !!fromToken && !!toToken && !hasContracts;
  const { data: walletBalances, refetch: refetchBalances } = useWalletBalances(address, contracts);
  const { addTrustlines, isAdding: isAddingTrustlines } = useAddCircleTrustlines();
  const [isOnChainSwapping, setIsOnChainSwapping] = useState(false);

  const circleTrustlineGap =
    fromToken && toToken && walletBalances
      ? circleTrustlinesNeeded(
          [fromToken.symbol, toToken.symbol],
          walletBalances.hasTrustline,
        )
      : [];
  const missingTrustlines = walletBalances
    ? (["USDC", "EURC"] as const).filter((sym) => !walletBalances.hasTrustline[sym])
    : [];
  const needsCircleTrustlines = !!address && missingTrustlines.length > 0;
  const swapNeedsTrustline = circleTrustlineGap.length > 0;

  const handleEnableCircleAssets = async () => {
    try {
      const hash = await addTrustlines([...missingTrustlines]);
      toast({
        title: "Trustlines enabled",
        description: `cUSDC/EURC can now be received. Tx ${hash.slice(0, 12)}…`,
      });
      await refetchBalances();
    } catch (err) {
      toast({ title: "Trustline failed", description: String(err), variant: "destructive" });
    }
  };

  const fromBalance = fromToken ? walletBalances?.bySymbol[fromToken.symbol] : undefined;
  const toBalance = toToken ? walletBalances?.bySymbol[toToken.symbol] : undefined;

  const setMaxFromAmount = () => {
    if (fromBalance === undefined || fromBalance <= 0) return;
    let maxBal = fromBalance;
    if (fromToken?.symbol === "XLM") {
      maxBal = Math.max(0, fromBalance - 1);
    }
    if (maxBal <= 0) return;
    const decimals = tokenDecimals(fromToken?.symbol ?? "XLM");
    const max = maxBal.toFixed(Math.min(decimals, 6)).replace(/\.?0+$/, "");
    setFromAmount(max);
  };

  const filteredTokens = useMemo(() => {
    if (!tokens) return [];
    const q = tokenSearch.trim().toLowerCase();
    if (!q) return tokens;
    return tokens.filter(
      (t) => t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q)
    );
  }, [tokens, tokenSearch]);

  const handlePrimaryAction = async () => {
    if (!address) {
      try {
        await connect();
      } catch {
        toast({ title: "Connect wallet to get started", variant: "destructive" });
      }
      return;
    }
    if (!fromTokenId || !toTokenId || !fromAmount || parseFloat(fromAmount) <= 0) return;

    if (pairUnsupported) {
      toast({
        title: "Token not on-chain",
        description: "This token has no Soroban contract configured.",
        variant: "destructive",
      });
      return;
    }

    if (!quote) return;

    if (!contracts?.contractsReady) {
      toast({
        title: "Contracts not deployed",
        description: "Deploy Soroban contracts and restart the API before swapping.",
        variant: "destructive",
      });
      return;
    }
    if (!fromToken || !toToken) return;

    if (!fromContract || !toContract) {
      toast({
        title: "Token not on-chain",
        description: `${fromToken.symbol}/${toToken.symbol} pair has no deployed token contracts.`,
        variant: "destructive",
      });
      return;
    }

    setIsOnChainSwapping(true);
    try {
      if (walletBalances && circleTrustlineGap.length > 0) {
        toast({
          title: "Enable trustline in Freighter",
          description: `Required to receive ${circleTrustlineGap.join(" / ")} on Stellar.`,
        });
        await addTrustlines([...circleTrustlineGap]);
        await refetchBalances();
      }

      const hash = await executeSwap({
        fromTokenContract: fromContract,
        toTokenContract: toContract,
        poolContract: contracts.pool || undefined,
        amountIn: parseTokenAmount(fromAmount, tokenDecimals(fromToken.symbol)).toString(),
        minAmountOut: quote?.minAmountOutRaw,
        slippageBps: 50,
      });
      toast({
        title: "Swap confirmed",
        description: `Tx ${hash.slice(0, 12)}… — ${fromAmount} ${fromToken.symbol} → ${toToken.symbol}`,
      });
      setFromAmount("");
    } catch (err) {
      toast({ title: "Swap failed", description: String(err), variant: "destructive" });
    } finally {
      setIsOnChainSwapping(false);
    }
  };

  const switchTokens = () => {
    setFromTokenId(toTokenId);
    setToTokenId(fromTokenId);
    setFromAmount("");
  };

  const showGetStarted = !address;
  const quoteErrorMessage =
    onChainQuoteError instanceof Error
      ? onChainQuoteError.message
      : onChainQuoteError
        ? String(onChainQuoteError)
        : null;

  const canSwap =
    address &&
    fromAmount &&
    parseFloat(fromAmount) > 0 &&
    hasContracts &&
    quote &&
    !onChainQuoteError;

  return (
    <div className="flex-1 flex flex-col items-center px-4 pt-10 pb-16 md:pt-16">
      <h1 className="text-[32px] md:text-[36px] font-bold text-foreground text-center mb-8 tracking-tight">
        Swap anytime, anywhere.
      </h1>

      <div className="w-full max-w-[480px] uni-swap-card p-2 relative">
        <div className="flex flex-col gap-1 relative">
          {/* Sell */}
          <div className="uni-token-panel">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[14px] text-muted-foreground font-medium">Sell</span>
              {address && fromToken && (
                <div className="flex items-center gap-1.5 text-[14px] text-muted-foreground">
                  <span>
                    Balance: {formatBalanceDisplay(fromBalance)}
                  </span>
                  {fromBalance !== undefined && fromBalance > 0 && (
                    <button
                      type="button"
                      onClick={setMaxFromAmount}
                      className="text-primary font-semibold hover:opacity-80 transition-opacity"
                    >
                      MAX
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className="flex items-center justify-between gap-3 mt-2">
              <div className="flex-1 min-w-0">
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="0"
                  value={fromAmount}
                  onChange={(e) => setFromAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                  className="uni-amount-input"
                />
                <p className="text-[14px] text-muted-foreground mt-1">
                  {fromToken ? usdValue(fromAmount, fromToken.price) : "$0"}
                </p>
              </div>
              {fromToken ? (
                <button type="button" onClick={() => setSelecting("from")} className="uni-token-btn">
                  {fromToken.logoUrl ? (
                    <img src={fromToken.logoUrl} alt={fromToken.symbol} className="w-6 h-6 rounded-full" />
                  ) : (
                    <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-[10px] font-bold">
                      {fromToken.symbol[0]}
                    </div>
                  )}
                  <span>{fromToken.symbol}</span>
                  <ChevronDown className="w-4 h-4 text-muted-foreground" />
                </button>
              ) : (
                <button type="button" onClick={() => setSelecting("from")} className="uni-select-token-btn">
                  Select token <ChevronDown className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>

          {/* Divider arrow */}
          <div className="relative h-0 flex items-center justify-center z-10 my-[-14px]">
            <button
              type="button"
              onClick={switchTokens}
              className="flex items-center justify-center w-9 h-9 rounded-full border-4 border-white bg-[#f5f5f7] hover:bg-[#ebebed] text-muted-foreground transition-colors shadow-sm"
            >
              <ChevronDown className="w-4 h-4" />
            </button>
          </div>

          {/* Buy */}
          <div className="uni-token-panel">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[14px] text-muted-foreground font-medium">Buy</span>
              {address && toToken && (
                <span className="text-[14px] text-muted-foreground">
                  Balance: {formatBalanceDisplay(toBalance)}
                </span>
              )}
            </div>
            <div className="flex items-center justify-between gap-3 mt-2">
              <div className="flex-1 min-w-0">
                <div className="text-[40px] font-medium leading-none text-foreground/80 py-0.5">
                  {isQuoting ? (
                    <Skeleton className="h-10 w-16 bg-muted-foreground/10" />
                  ) : (
                    quote?.outputAmount ? quote.outputAmount.toFixed(6) : "0"
                  )}
                </div>
                {toToken && quote && (
                  <p className="text-[14px] text-muted-foreground mt-1">
                    {usdValue(String(quote.outputAmount ?? 0), toToken.price)}
                  </p>
                )}
              </div>
              {toToken ? (
                <button type="button" onClick={() => setSelecting("to")} className="uni-token-btn">
                  {toToken.logoUrl ? (
                    <img src={toToken.logoUrl} alt={toToken.symbol} className="w-6 h-6 rounded-full" />
                  ) : (
                    <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-[10px] font-bold">
                      {toToken.symbol[0]}
                    </div>
                  )}
                  <span>{toToken.symbol}</span>
                  <ChevronDown className="w-4 h-4 text-muted-foreground" />
                </button>
              ) : (
                <button type="button" onClick={() => setSelecting("to")} className="uni-select-token-btn">
                  Select token <ChevronDown className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="p-1 pt-3">
          {showGetStarted ? (
            <button type="button" onClick={handlePrimaryAction} className="uni-get-started-btn">
              Get started
            </button>
          ) : onChainQuoteError && fromAmount && parseFloat(fromAmount) > 0 ? (
            <button
              type="button"
              disabled
              title={quoteErrorMessage ?? undefined}
              className="uni-get-started-btn opacity-60 cursor-not-allowed text-sm px-4"
            >
              {quoteErrorMessage?.toLowerCase().includes("pool")
                ? quoteErrorMessage
                : quoteErrorMessage ?? "Quote unavailable"}
            </button>
          ) : canSwap ? (
            <button
              type="button"
              onClick={handlePrimaryAction}
              disabled={isOnChainSwapping || isAddingTrustlines}
              className="uni-swap-btn bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              {isOnChainSwapping
                ? "Swapping..."
                : isAddingTrustlines
                  ? "Confirm in Freighter…"
                  : swapNeedsTrustline
                    ? `Enable ${circleTrustlineGap.join(" + ")} & swap`
                    : "Swap"}
            </button>
          ) : (
            <button type="button" disabled className="uni-get-started-btn opacity-60 cursor-not-allowed">
              Enter an amount
            </button>
          )}
        </div>
      </div>

      {needsCircleTrustlines && (
        <div className="w-full max-w-[480px] mt-4 rounded-[20px] border border-amber-200/80 bg-amber-50 px-4 py-3.5">
          <p className="text-[14px] font-medium text-amber-950">
            Enable Circle cUSDC &amp; EURC
          </p>
          <p className="text-[13px] text-amber-900/80 mt-1 leading-relaxed">
            Stellar requires a trustline before you can receive or swap{" "}
            {missingTrustlines.join(" and ")}. Approve once in Freighter (~0.5 XLM reserve per
            asset), then swap or claim from the Circle faucet.
          </p>
          <div className="flex flex-wrap items-center gap-2 mt-3">
            <button
              type="button"
              onClick={handleEnableCircleAssets}
              disabled={isAddingTrustlines}
              className="rounded-[14px] bg-amber-900 text-amber-50 px-4 py-2 text-[14px] font-semibold hover:bg-amber-800 disabled:opacity-60 transition-colors"
            >
              {isAddingTrustlines ? "Confirm in Freighter…" : `Enable ${missingTrustlines.join(" + ")}`}
            </button>
            <a
              href={CIRCLE_FAUCET_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-[14px] border border-amber-300 bg-white px-4 py-2 text-[14px] font-semibold text-amber-950 hover:bg-amber-100/60 transition-colors"
            >
              Open Circle faucet
            </a>
          </div>
        </div>
      )}

      <p className="text-center text-[14px] text-muted-foreground mt-8 max-w-[520px] leading-relaxed">
        Buy and sell tokens with{" "}
        <span className="text-primary font-medium">zero app fees</span> on Stellar testnet
        including XLM, pUSDC, cUSDC, EURC, and on-chain routes.
      </p>

      {/* Token picker */}
      <Dialog open={selecting !== null} onOpenChange={(o) => { if (!o) { setSelecting(null); setTokenSearch(""); } }}>
        <DialogContent className="sm:max-w-md rounded-[24px] p-0 gap-0 overflow-hidden">
          <DialogHeader className="px-4 pt-4 pb-2">
            <DialogTitle className="text-left">Select a token</DialogTitle>
          </DialogHeader>
          <div className="px-4 pb-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search name or symbol"
                value={tokenSearch}
                onChange={(e) => setTokenSearch(e.target.value)}
                className="pl-9 rounded-[16px] bg-[#f5f5f7] border-none h-11"
              />
            </div>
          </div>
          <div className="flex flex-col max-h-[360px] overflow-y-auto px-2 pb-2">
            {isLoadingTokens ? (
              Array(4).fill(0).map((_, i) => <Skeleton key={i} className="h-14 w-full rounded-[16px] m-1" />)
            ) : (
              filteredTokens.map((token) => {
                const selectedId = selecting === "from" ? fromTokenId : toTokenId;
                return (
                  <button
                    key={token.id}
                    type="button"
                    className={`flex items-center gap-3 p-3 m-1 rounded-[16px] text-left transition-colors ${
                      selectedId === token.id ? "bg-primary/10 pointer-events-none" : "hover:bg-[#f5f5f7]"
                    }`}
                    onClick={() => {
                      if (selecting === "from") setFromTokenId(token.id);
                      else setToTokenId(token.id);
                      setSelecting(null);
                      setTokenSearch("");
                    }}
                  >
                    {token.logoUrl ? (
                      <img src={token.logoUrl} alt={token.symbol} className="w-9 h-9 rounded-full" />
                    ) : (
                      <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center font-bold text-sm">
                        {token.symbol[0]}
                      </div>
                    )}
                    <div className="flex flex-col flex-1 min-w-0">
                      <span className="font-semibold">{token.symbol}</span>
                      <span className="text-sm text-muted-foreground truncate">{token.name}</span>
                    </div>
                    {address && (
                      <span className="text-sm text-muted-foreground tabular-nums">
                        {formatBalanceDisplay(walletBalances?.bySymbol[token.symbol])}
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
