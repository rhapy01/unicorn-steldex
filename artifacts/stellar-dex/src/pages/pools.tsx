import React, { useState } from "react";
import { useListPools, getListPoolsQueryKey } from "@workspace/api-client-react";
import { useWallet } from "@/hooks/use-wallet";
import { useStellarContract } from "@/hooks/use-stellar";
import { useContracts } from "@/hooks/use-contracts";
import {
  canonicalizeTokenPair,
  parseTokenAmount,
  resolvePoolContract,
  resolveTokenContract,
  tokenDecimals,
} from "@/lib/onchain";
import { fullRangeTicks } from "@/lib/pool-ticks";
import { useToast } from "@/hooks/use-toast";
import { formatBalanceDisplay, useWalletBalances } from "@/hooks/use-wallet-balances";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";

export default function Pools() {
  const { data: pools, isLoading } = useListPools();
  const { address } = useWallet();
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="container mx-auto p-4 md:p-8 space-y-8 animate-in fade-in duration-500">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Liquidity Pools</h1>
          <p className="text-muted-foreground mt-1">Provide liquidity to earn fees and rewards.</p>
        </div>
        <Button className="rounded-full shadow-lg" onClick={() => setCreateOpen(true)}>
          <Plus className="w-4 h-4 mr-2" /> Create New Pool
        </Button>
      </div>

      <CreatePoolDialog open={createOpen} onOpenChange={setCreateOpen} address={address} />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {isLoading ? (
          Array(10).fill(0).map((_, i) => (
            <Card key={i} className="glass-card overflow-hidden">
              <CardHeader className="pb-4">
                <Skeleton className="h-8 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
              </CardHeader>
              <CardContent className="space-y-4">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-10 w-full rounded-xl" />
              </CardContent>
            </Card>
          ))
        ) : (
          pools?.map((pool) => (
            <PoolCard key={pool.id} pool={pool} address={address} />
          ))
        )}
      </div>
    </div>
  );
}

function CreatePoolDialog({
  open,
  onOpenChange,
  address,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  address: string | null;
}) {
  const [token0Symbol, setToken0Symbol] = useState("XLM");
  const [token1Symbol, setToken1Symbol] = useState("pUSDC");
  const [feeTier, setFeeTier] = useState("Medium");
  const [isPending, setIsPending] = useState(false);

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { createPool } = useStellarContract();
  const { data: contracts } = useContracts();

  const TOKEN_OPTIONS = ["XLM", "pUSDC", "cUSDC", "EURC", "STELLAR"];
  const FEE_TIERS = [
    { value: "Low", label: "0.05% — stable pairs" },
    { value: "Medium", label: "0.30% — most pairs" },
    { value: "High", label: "1.00% — exotic pairs" },
  ];

  const handleCreate = async () => {
    if (!address) {
      toast({ title: "Connect wallet first", variant: "destructive" });
      return;
    }
    if (token0Symbol === token1Symbol) {
      toast({ title: "Select two different tokens", variant: "destructive" });
      return;
    }
    if (!contracts?.contractsReady) {
      toast({ title: "Contracts not deployed", variant: "destructive" });
      return;
    }

    const t0 = resolveTokenContract(token0Symbol, contracts);
    const t1 = resolveTokenContract(token1Symbol, contracts);

    if (!t0 || !t1) {
      toast({
        title: "Token contract not found",
        description: `No contract address for ${!t0 ? token0Symbol : token1Symbol}`,
        variant: "destructive",
      });
      return;
    }

    setIsPending(true);
    toast({ title: "Sign in Freighter", description: "Confirm create pool transaction." });
    try {
      const hash = await createPool({ token0Contract: t0, token1Contract: t1, feeTier });
      toast({
        title: "Pool created",
        description: `${token0Symbol}/${token1Symbol} pool deployed. Tx ${hash.slice(0, 12)}…`,
      });
      onOpenChange(false);
      queryClient.invalidateQueries({ queryKey: getListPoolsQueryKey() });
    } catch (e) {
      toast({ title: "Create pool failed", description: String(e), variant: "destructive" });
    } finally {
      setIsPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create New Pool</DialogTitle>
          <CardDescription>Deploy a new CLMM liquidity pool via the factory contract.</CardDescription>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="space-y-2">
            <Label>Token A</Label>
            <Select value={token0Symbol} onValueChange={setToken0Symbol}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {TOKEN_OPTIONS.filter((t) => t !== token1Symbol).map((t) => (
                  <SelectItem key={t} value={t}>{t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Token B</Label>
            <Select value={token1Symbol} onValueChange={setToken1Symbol}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {TOKEN_OPTIONS.filter((t) => t !== token0Symbol).map((t) => (
                  <SelectItem key={t} value={t}>{t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Fee Tier</Label>
            <Select value={feeTier} onValueChange={setFeeTier}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {FEE_TIERS.map((f) => (
                  <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="bg-muted/50 rounded-lg p-3 text-xs text-muted-foreground leading-relaxed">
            A new concentrated liquidity pool will be deployed on Stellar testnet via the factory contract.
            After creation, add initial liquidity to activate it.
          </div>
          <Button
            className="w-full h-11 rounded-xl"
            onClick={handleCreate}
            disabled={isPending || !address}
          >
            {isPending ? "Creating Pool…" : `Create ${token0Symbol}/${token1Symbol} Pool`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PoolCard({ pool, address }: { pool: any, address: string | null }) {
  const [isOpen, setIsOpen] = useState(false);
  const [amountA, setAmountA] = useState("");
  const [amountB, setAmountB] = useState("");
  const [isOnChainPending, setIsOnChainPending] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { addLiquidity } = useStellarContract();
  const { data: contracts } = useContracts();
  const { data: walletBalances } = useWalletBalances(address, contracts);

  const balanceA = walletBalances?.bySymbol[pool.tokenA.symbol];
  const balanceB = walletBalances?.bySymbol[pool.tokenB.symbol];

  const maxSpendable = (symbol: string, balance: number | undefined) => {
    if (balance === undefined || balance <= 0) return 0;
    if (symbol === "XLM") return Math.max(0, balance - 1);
    return balance;
  };

  const setMaxAmountA = () => {
    const max = maxSpendable(pool.tokenA.symbol, balanceA);
    if (max <= 0) return;
    const formatted = max.toFixed(Math.min(tokenDecimals(pool.tokenA.symbol), 6)).replace(/\.?0+$/, "");
    setAmountA(formatted);
    setAmountB((max * poolPriceRatio()).toFixed(6));
  };

  const setMaxAmountB = () => {
    const max = maxSpendable(pool.tokenB.symbol, balanceB);
    if (max <= 0) return;
    const formatted = max.toFixed(Math.min(tokenDecimals(pool.tokenB.symbol), 6)).replace(/\.?0+$/, "");
    setAmountB(formatted);
    const ratio = poolPriceRatio();
    setAmountA(ratio > 0 ? (max / ratio).toFixed(6) : "");
  };

  const poolPriceRatio = () => {
    if (pool.reserveA > 0 && pool.reserveB > 0) {
      return pool.reserveB / pool.reserveA;
    }
    const priceA = pool.tokenA.price || 1;
    const priceB = pool.tokenB.price || 1;
    return priceA / priceB;
  };

  const handleAmountAChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setAmountA(val);
    if (val && parseFloat(val) > 0) {
      setAmountB((parseFloat(val) * poolPriceRatio()).toFixed(6));
    } else {
      setAmountB("");
    }
  };

  const handleAmountBChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setAmountB(val);
    if (val && parseFloat(val) > 0) {
      const ratio = poolPriceRatio();
      setAmountA(ratio > 0 ? (parseFloat(val) / ratio).toFixed(6) : "");
    } else {
      setAmountA("");
    }
  };

  const handleAddLiquidity = async () => {
    if (!address) {
      toast({ title: "Wallet required", description: "Connect wallet to add liquidity", variant: "destructive" });
      return;
    }

    if (!contracts?.contractsReady) {
      toast({
        title: "Contracts not deployed",
        description: "Deploy Soroban contracts before adding liquidity.",
        variant: "destructive",
      });
      return;
    }

    const poolContract =
      pool.poolContract ??
      resolvePoolContract(pool.tokenA.symbol, pool.tokenB.symbol, contracts);
    const token0 = resolveTokenContract(pool.tokenA.symbol, contracts);
    const token1 = resolveTokenContract(pool.tokenB.symbol, contracts);

    if (!poolContract || !token0 || !token1) {
      toast({
        title: "Pool not on-chain",
        description: `${pool.tokenA.symbol}/${pool.tokenB.symbol} has no deployed pool contract.`,
        variant: "destructive",
      });
      return;
    }

    const amountAUnits = parseTokenAmount(amountA, tokenDecimals(pool.tokenA.symbol)).toString();
    const amountBUnits = parseTokenAmount(amountB, tokenDecimals(pool.tokenB.symbol)).toString();
    const ordered = canonicalizeTokenPair(token0, token1, amountAUnits, amountBUnits);

    setIsOnChainPending(true);
    toast({
      title: "Sign transactions in Freighter",
      description: "You may be prompted up to 4 times: wrap XLM, approve tokens, then mint liquidity.",
    });
    try {
      const { tickLower, tickUpper } = fullRangeTicks();
      const hash = await addLiquidity({
        poolContract,
        token0Contract: ordered.token0,
        token1Contract: ordered.token1,
        tickLower,
        tickUpper,
        amount0Desired: ordered.amount0,
        amount1Desired: ordered.amount1,
      });
      toast({
        title: "Liquidity added",
        description: `Tx ${hash.slice(0, 12)}… — ${pool.tokenA.symbol}/${pool.tokenB.symbol}`,
      });
      setIsOpen(false);
      setAmountA("");
      setAmountB("");
      queryClient.invalidateQueries({ queryKey: getListPoolsQueryKey() });
    } catch (err) {
      toast({ title: "Add liquidity failed", description: String(err), variant: "destructive" });
    } finally {
      setIsOnChainPending(false);
    }
  };

  return (
    <Card className="glass-card hover:border-primary/30 transition-colors overflow-hidden flex flex-col group">
      <CardHeader className="pb-4 border-b border-border/50 bg-muted/20 group-hover:bg-muted/40 transition-colors">
        <div className="flex justify-between items-start">
          <div className="flex items-center gap-3">
            <div className="flex -space-x-3">
              {pool.tokenA.logoUrl ? <img src={pool.tokenA.logoUrl} className="w-8 h-8 rounded-full ring-2 ring-card" /> : <div className="w-8 h-8 rounded-full bg-primary/20 ring-2 ring-card" />}
              {pool.tokenB.logoUrl ? <img src={pool.tokenB.logoUrl} className="w-8 h-8 rounded-full ring-2 ring-card z-10" /> : <div className="w-8 h-8 rounded-full bg-blue-500/20 ring-2 ring-card z-10" />}
            </div>
            <div>
              <CardTitle className="text-xl">{pool.tokenA.symbol} / {pool.tokenB.symbol}</CardTitle>
              <div className="flex items-center gap-2 mt-1">
                <Badge variant="secondary" className="font-mono">{pool.fee * 100}% fee</Badge>
                {pool.lpTokenSupply > 0 ? (
                  <Badge className="bg-green-500/20 text-green-500 hover:bg-green-500/30 border-none font-mono">
                    Live
                  </Badge>
                ) : (
                  <Badge variant="outline" className="font-mono text-muted-foreground">
                    Empty
                  </Badge>
                )}
              </div>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-4 flex-1 flex flex-col justify-between space-y-6">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Total Liquidity</p>
            <p className="text-lg font-mono font-medium">${pool.totalLiquidity.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</p>
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">24h Volume</p>
            <p className="text-lg font-mono font-medium">${pool.volume24h.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</p>
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">{pool.tokenA.symbol} Reserve</p>
            <p className="text-sm font-mono text-muted-foreground">{pool.reserveA.toLocaleString(undefined, {maximumFractionDigits: 2})}</p>
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">{pool.tokenB.symbol} Reserve</p>
            <p className="text-sm font-mono text-muted-foreground">{pool.reserveB.toLocaleString(undefined, {maximumFractionDigits: 2})}</p>
          </div>
        </div>

        <Dialog open={isOpen} onOpenChange={setIsOpen}>
          <DialogTrigger asChild>
            <Button className="w-full rounded-xl" variant="default">
              <Plus className="w-4 h-4 mr-2" /> Add Liquidity
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Add Liquidity to {pool.tokenA.symbol}/{pool.tokenB.symbol}</DialogTitle>
              <CardDescription>
                Provide liquidity to earn {pool.fee * 100}% on all trades in this pool proportional to your share.
              </CardDescription>
            </DialogHeader>
            <div className="space-y-4 pt-4">
              <p className="text-xs text-muted-foreground leading-relaxed rounded-lg bg-muted/50 px-3 py-2">
                Deposits use Soroban token contracts for this pair. XLM is wrapped automatically; pUSDC/STELLAR can be
                auto-minted on testnet. Circle cUSDC/EURC require faucet funds and trustlines (enable on Swap).
              </p>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label>{pool.tokenA.symbol} Amount</Label>
                  {address ? (
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span>Balance: {formatBalanceDisplay(balanceA)}</span>
                      {balanceA !== undefined && maxSpendable(pool.tokenA.symbol, balanceA) > 0 && (
                        <button
                          type="button"
                          onClick={setMaxAmountA}
                          className="text-primary font-semibold hover:opacity-80 transition-opacity"
                        >
                          MAX
                        </button>
                      )}
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">Connect wallet</span>
                  )}
                </div>
                <div className="relative">
                  <Input 
                    type="number" 
                    placeholder="0.00" 
                    value={amountA} 
                    onChange={handleAmountAChange}
                    className="font-mono text-lg pr-16"
                  />
                  <div className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground font-bold">
                    {pool.tokenA.symbol}
                  </div>
                </div>
              </div>
              <div className="flex justify-center">
                <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center text-muted-foreground">
                  <Plus className="w-4 h-4" />
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label>{pool.tokenB.symbol} Amount</Label>
                  {address ? (
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span>Balance: {formatBalanceDisplay(balanceB)}</span>
                      {balanceB !== undefined && maxSpendable(pool.tokenB.symbol, balanceB) > 0 && (
                        <button
                          type="button"
                          onClick={setMaxAmountB}
                          className="text-primary font-semibold hover:opacity-80 transition-opacity"
                        >
                          MAX
                        </button>
                      )}
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">Connect wallet</span>
                  )}
                </div>
                <div className="relative">
                  <Input 
                    type="number" 
                    placeholder="0.00" 
                    value={amountB} 
                    onChange={handleAmountBChange}
                    className="font-mono text-lg pr-16"
                  />
                  <div className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground font-bold">
                    {pool.tokenB.symbol}
                  </div>
                </div>
              </div>
              
              <div className="bg-muted/50 p-3 rounded-lg text-sm flex justify-between items-center text-muted-foreground">
                <span>Current Ratio</span>
                <span className="font-mono">
                  1 {pool.tokenA.symbol} = {poolPriceRatio().toFixed(4)} {pool.tokenB.symbol}
                </span>
              </div>

              <Button 
                className="w-full h-12 text-lg rounded-xl mt-4" 
                onClick={handleAddLiquidity}
                disabled={!amountA || parseFloat(amountA) <= 0 || isOnChainPending}
              >
                {isOnChainPending ? "Adding Liquidity..." : "Add Liquidity"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
