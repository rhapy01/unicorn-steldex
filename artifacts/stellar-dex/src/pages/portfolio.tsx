import React, { useState } from "react";
import { Link } from "wouter";
import { useGetPortfolio } from "@workspace/api-client-react";
import { useWallet } from "@/hooks/use-wallet";
import { useStellarContract } from "@/hooks/use-stellar";
import { useContracts } from "@/hooks/use-contracts";
import { resolvePoolContract, resolveTokenContract, tokenDecimals, parseTokenAmount } from "@/lib/onchain";
import { fullRangeTicks } from "@/lib/pool-ticks";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { getGetPortfolioQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Wallet, ArrowRightLeft, ArrowDownToLine, ArrowUpFromLine, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export default function Portfolio() {
  const { address } = useWallet();

  if (!address) {
    return (
      <div className="container mx-auto p-4 md:p-8 flex items-center justify-center min-h-[60vh]">
        <div className="text-center space-y-4 max-w-md">
          <div className="w-20 h-20 bg-primary/10 rounded-full flex items-center justify-center mx-auto text-primary">
            <Wallet className="w-10 h-10" />
          </div>
          <h2 className="text-2xl font-bold">Wallet Not Connected</h2>
          <p className="text-muted-foreground">Connect Freighter to view your portfolio, balances, and LP positions.</p>
        </div>
      </div>
    );
  }

  return <PortfolioDashboard address={address} />;
}

function PortfolioDashboard({ address }: { address: string }) {
  const { data: portfolio, isLoading } = useGetPortfolio(
    { walletAddress: address },
    { query: { enabled: !!address, refetchInterval: 30_000, staleTime: 15_000 } },
  );

  const formatCurrency = (val: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(val);

  return (
    <div className="container mx-auto p-4 md:p-8 space-y-8 animate-in fade-in duration-500">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">Portfolio</h1>
        <p className="text-muted-foreground font-mono text-sm">{address}</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left: Total + Token Balances */}
        <div className="lg:col-span-1 space-y-6">
          <Card className="glass-card bg-gradient-to-br from-card to-primary/5 border-primary/20">
            <CardHeader className="pb-2">
              <CardDescription>Total Balance</CardDescription>
              {isLoading ? (
                <Skeleton className="h-12 w-48 mt-2" />
              ) : (
                <CardTitle className="text-4xl font-mono">{formatCurrency(portfolio?.totalValueUsd || 0)}</CardTitle>
              )}
            </CardHeader>
            <CardContent>
              <div className="flex gap-2 mt-4">
                <Link href="/pool">
                  <Button className="flex-1 rounded-xl shadow-sm" variant="secondary">Add Liquidity</Button>
                </Link>
                <Link href="/swap">
                  <Button className="flex-1 rounded-xl shadow-sm" variant="secondary">Swap</Button>
                </Link>
              </div>
            </CardContent>
          </Card>

          <Card className="glass-card">
            <CardHeader>
              <CardTitle className="text-lg">Token Balances</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {isLoading ? (
                Array(3).fill(0).map((_, i) => (
                  <div key={i} className="flex justify-between items-center">
                    <div className="flex items-center gap-3">
                      <Skeleton className="w-8 h-8 rounded-full" />
                      <div>
                        <Skeleton className="h-4 w-16 mb-1" />
                        <Skeleton className="h-3 w-24" />
                      </div>
                    </div>
                    <div className="text-right">
                      <Skeleton className="h-4 w-20 mb-1 ml-auto" />
                      <Skeleton className="h-3 w-16 ml-auto" />
                    </div>
                  </div>
                ))
              ) : portfolio?.tokenBalances.length === 0 ? (
                <div className="text-center py-6 text-muted-foreground text-sm">No tokens in wallet</div>
              ) : (
                portfolio?.tokenBalances.map((tb) => (
                  <div key={tb.token.id} className="flex justify-between items-center group">
                    <div className="flex items-center gap-3">
                      {tb.token.logoUrl ? (
                        <img src={tb.token.logoUrl} alt={tb.token.symbol} className="w-8 h-8 rounded-full" />
                      ) : (
                        <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center font-bold text-xs">{tb.token.symbol[0]}</div>
                      )}
                      <div>
                        <div className="font-bold">{tb.token.symbol}</div>
                        <div className="text-xs text-muted-foreground">{tb.token.name}</div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-mono font-medium">{tb.balance.toLocaleString(undefined, { maximumFractionDigits: 6 })}</div>
                      <div className="text-xs text-muted-foreground">{formatCurrency(tb.valueUsd)}</div>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right: LP Positions */}
        <div className="lg:col-span-2 space-y-6">
          <Card className="glass-card h-full">
            <CardHeader>
              <CardTitle className="text-lg">Liquidity Positions</CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="space-y-4">
                  <Skeleton className="h-24 w-full rounded-xl" />
                  <Skeleton className="h-24 w-full rounded-xl" />
                </div>
              ) : portfolio?.lpPositions.length === 0 ? (
                <div className="text-center py-12 flex flex-col items-center">
                  <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mb-4">
                    <ArrowDownToLine className="w-8 h-8 text-muted-foreground" />
                  </div>
                  <h3 className="text-lg font-medium">No Liquidity Positions</h3>
                  <p className="text-muted-foreground text-sm mb-4">You aren't providing liquidity to any pools.</p>
                  <Link href="/pool">
                    <Button variant="outline" className="rounded-xl">Explore Pools</Button>
                  </Link>
                </div>
              ) : (
                <div className="space-y-4">
                  {portfolio?.lpPositions.map((pos) => (
                    <LpPositionCard
                      key={pos.pool.id}
                      pos={pos}
                      walletAddress={address}
                      formatCurrency={formatCurrency}
                    />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Recent Activity */}
      <Card className="glass-card">
        <CardHeader>
          <CardTitle className="text-lg">Recent Activity</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-4">
              {Array(3).fill(0).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full rounded-xl" />
              ))}
            </div>
          ) : portfolio?.recentTransactions.length === 0 ? (
            <div className="text-center py-6 text-muted-foreground text-sm">No recent transactions</div>
          ) : (
            <div className="space-y-4">
              {portfolio?.recentTransactions.map((tx) => {
                const isSoroban = tx.tokenASymbol === "—";
                return (
                  <div key={tx.id} className="flex justify-between items-center p-3 rounded-xl hover:bg-muted/50 transition-colors">
                    <div className="flex items-center gap-4">
                      <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                        tx.type === "swap" ? "bg-primary/20 text-primary" :
                        tx.type === "add_liquidity" ? "bg-green-500/20 text-green-500" : "bg-red-500/20 text-red-500"
                      }`}>
                        {tx.type === "swap" ? <ArrowRightLeft className="w-5 h-5" /> :
                         tx.type === "add_liquidity" ? <ArrowDownToLine className="w-5 h-5" /> :
                         <ArrowUpFromLine className="w-5 h-5" />}
                      </div>
                      <div>
                        <div className="font-medium capitalize flex items-center gap-2">
                          {isSoroban ? "Soroban contract call" : tx.type.replace(/_/g, " ")}
                          {tx.status === "pending" && <Badge variant="outline" className="text-[10px] text-yellow-500 border-yellow-500/50">Pending</Badge>}
                          {tx.status === "failed" && <Badge variant="outline" className="text-[10px] text-destructive border-destructive/50">Failed</Badge>}
                        </div>
                        <div className="text-xs text-muted-foreground">{new Date(tx.timestamp).toLocaleString()}</div>
                      </div>
                    </div>
                    <div className="text-right flex items-center gap-2">
                      {!isSoroban && (
                        <div className="font-mono font-medium text-sm">
                          {tx.type === "swap"
                            ? `${tx.amountA} ${tx.tokenASymbol} → ${tx.amountB} ${tx.tokenBSymbol}`
                            : `${tx.amountA} ${tx.tokenASymbol} + ${tx.amountB} ${tx.tokenBSymbol}`}
                        </div>
                      )}
                      {tx.valueUsd != null && (
                        <div className="text-xs text-muted-foreground">{formatCurrency(tx.valueUsd)}</div>
                      )}
                      <a
                        href={`https://stellar.expert/explorer/testnet/tx/${tx.txHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground hover:text-primary transition-colors"
                      >
                        <ExternalLink className="w-4 h-4" />
                      </a>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

type LpPos = {
  pool: {
    id: number;
    tokenA: { symbol: string; logoUrl?: string | null; price: number };
    tokenB: { symbol: string; logoUrl?: string | null; price: number };
    fee: number;
    poolContract?: string | null;
  };
  lpTokenBalance: number;
  sharePercent: number;
  valueUsd: number;
  feesEarned: number;
};

function LpPositionCard({
  pos,
  walletAddress,
  formatCurrency,
}: {
  pos: LpPos;
  walletAddress: string;
  formatCurrency: (v: number) => string;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [amountA, setAmountA] = useState("");
  const [amountB, setAmountB] = useState("");
  const [removePct, setRemovePct] = useState("100");
  const [isPending, setIsPending] = useState(false);

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { addLiquidity, removeLiquidity } = useStellarContract();
  const { data: contracts } = useContracts();

  const poolPriceRatio = () => {
    const priceA = pos.pool.tokenA.price || 1;
    const priceB = pos.pool.tokenB.price || 1;
    return priceA / priceB;
  };

  const handleAdd = async () => {
    if (!contracts?.contractsReady) {
      toast({ title: "Contracts not ready", variant: "destructive" });
      return;
    }
    const poolContract =
      (pos.pool.poolContract as string | undefined) ??
      resolvePoolContract(pos.pool.tokenA.symbol, pos.pool.tokenB.symbol, contracts);
    const token0 = resolveTokenContract(pos.pool.tokenA.symbol, contracts);
    const token1 = resolveTokenContract(pos.pool.tokenB.symbol, contracts);

    if (!poolContract || !token0 || !token1) {
      toast({ title: "Pool contract not found", variant: "destructive" });
      return;
    }

    const { tickLower, tickUpper } = fullRangeTicks();
    const a0 = parseTokenAmount(amountA, tokenDecimals(pos.pool.tokenA.symbol)).toString();
    const a1 = parseTokenAmount(amountB, tokenDecimals(pos.pool.tokenB.symbol)).toString();
    const ordered =
      token0 < token1
        ? { token0Contract: token0, token1Contract: token1, amount0Desired: a0, amount1Desired: a1 }
        : { token0Contract: token1, token1Contract: token0, amount0Desired: a1, amount1Desired: a0 };

    setIsPending(true);
    toast({ title: "Sign in Freighter", description: "Up to 4 signing prompts: wrap XLM, approvals, mint." });
    try {
      const hash = await addLiquidity({ poolContract, tickLower, tickUpper, ...ordered });
      toast({ title: "Liquidity added", description: `Tx ${hash.slice(0, 12)}…` });
      setAddOpen(false);
      setAmountA("");
      setAmountB("");
      queryClient.invalidateQueries({ queryKey: getGetPortfolioQueryKey({ walletAddress }) });
    } catch (e) {
      toast({ title: "Failed", description: String(e), variant: "destructive" });
    } finally {
      setIsPending(false);
    }
  };

  const handleRemove = async () => {
    const poolContract =
      (pos.pool.poolContract as string | undefined) ??
      resolvePoolContract(pos.pool.tokenA.symbol, pos.pool.tokenB.symbol, contracts);

    if (!poolContract) {
      toast({ title: "Pool contract not found", variant: "destructive" });
      return;
    }

    const pct = Math.min(100, Math.max(1, parseFloat(removePct) || 100));
    const liquidityToRemove = BigInt(Math.floor(pos.lpTokenBalance * (pct / 100))).toString();
    const { tickLower, tickUpper } = fullRangeTicks();

    setIsPending(true);
    toast({ title: "Sign in Freighter", description: "Confirm remove liquidity transaction." });
    try {
      const hash = await removeLiquidity({ poolContract, tickLower, tickUpper, liquidity: liquidityToRemove });
      toast({ title: "Liquidity removed", description: `Tx ${hash.slice(0, 12)}…` });
      setRemoveOpen(false);
      queryClient.invalidateQueries({ queryKey: getGetPortfolioQueryKey({ walletAddress }) });
    } catch (e) {
      toast({ title: "Failed", description: String(e), variant: "destructive" });
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div className="border border-border/50 rounded-xl p-4 bg-muted/20 hover:bg-muted/40 transition-colors">
      <div className="flex justify-between items-start mb-4">
        <div className="flex items-center gap-3">
          <div className="flex -space-x-3">
            {pos.pool.tokenA.logoUrl
              ? <img src={pos.pool.tokenA.logoUrl} className="w-8 h-8 rounded-full ring-2 ring-card" />
              : <div className="w-8 h-8 rounded-full bg-primary/20 ring-2 ring-card" />}
            {pos.pool.tokenB.logoUrl
              ? <img src={pos.pool.tokenB.logoUrl} className="w-8 h-8 rounded-full ring-2 ring-card z-10" />
              : <div className="w-8 h-8 rounded-full bg-blue-500/20 ring-2 ring-card z-10" />}
          </div>
          <div>
            <div className="font-bold text-lg">{pos.pool.tokenA.symbol} / {pos.pool.tokenB.symbol}</div>
            <div className="flex gap-2 mt-1">
              <Badge variant="outline" className="text-xs">{pos.pool.fee * 100}% fee</Badge>
              <Badge className="bg-green-500/10 text-green-500 hover:bg-green-500/20 border-none">
                {(pos.sharePercent * 100).toFixed(4)}% share
              </Badge>
            </div>
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-xl font-bold">{formatCurrency(pos.valueUsd)}</div>
          <div className="text-sm text-green-500 mt-1">+{formatCurrency(pos.feesEarned)} fees earned</div>
        </div>
      </div>

      <div className="flex gap-2">
        <Button variant="secondary" size="sm" className="w-full rounded-lg" onClick={() => setAddOpen(true)}>
          Add
        </Button>
        <Button variant="outline" size="sm" className="w-full rounded-lg" onClick={() => setRemoveOpen(true)}>
          Remove
        </Button>
      </div>

      {/* Add liquidity dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add to {pos.pool.tokenA.symbol}/{pos.pool.tokenB.symbol}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="space-y-2">
              <Label>{pos.pool.tokenA.symbol} Amount</Label>
              <Input
                type="number"
                placeholder="0.00"
                value={amountA}
                onChange={(e) => {
                  setAmountA(e.target.value);
                  if (e.target.value) setAmountB((parseFloat(e.target.value) * poolPriceRatio()).toFixed(6));
                }}
                className="font-mono text-lg"
              />
            </div>
            <div className="space-y-2">
              <Label>{pos.pool.tokenB.symbol} Amount</Label>
              <Input
                type="number"
                placeholder="0.00"
                value={amountB}
                onChange={(e) => {
                  setAmountB(e.target.value);
                  const ratio = poolPriceRatio();
                  if (e.target.value && ratio > 0) setAmountA((parseFloat(e.target.value) / ratio).toFixed(6));
                }}
                className="font-mono text-lg"
              />
            </div>
            <Button
              className="w-full h-11 rounded-xl"
              onClick={handleAdd}
              disabled={!amountA || parseFloat(amountA) <= 0 || isPending}
            >
              {isPending ? "Adding…" : "Add Liquidity"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Remove liquidity dialog */}
      <Dialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove from {pos.pool.tokenA.symbol}/{pos.pool.tokenB.symbol}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="bg-muted/50 rounded-lg p-3 text-sm space-y-1">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Your position value</span>
                <span className="font-mono font-medium">{formatCurrency(pos.valueUsd)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">LP tokens</span>
                <span className="font-mono">{pos.lpTokenBalance.toLocaleString()}</span>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Percentage to remove: {removePct}%</Label>
              <input
                type="range"
                min={1}
                max={100}
                value={removePct}
                onChange={(e) => setRemovePct(e.target.value)}
                className="w-full accent-primary"
              />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>1%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span>
              </div>
            </div>
            <div className="flex gap-2">
              {["25", "50", "75", "100"].map((pct) => (
                <Button key={pct} variant="outline" size="sm" className="flex-1" onClick={() => setRemovePct(pct)}>
                  {pct}%
                </Button>
              ))}
            </div>
            <div className="bg-muted/50 rounded-lg p-3 text-sm flex justify-between">
              <span className="text-muted-foreground">Removing</span>
              <span className="font-mono">{formatCurrency(pos.valueUsd * (parseFloat(removePct) / 100))}</span>
            </div>
            <Button
              className="w-full h-11 rounded-xl"
              variant="destructive"
              onClick={handleRemove}
              disabled={isPending}
            >
              {isPending ? "Removing…" : `Remove ${removePct}%`}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
