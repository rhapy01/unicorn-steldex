import { useState, useEffect } from "react";
import { useWallet } from "@/hooks/use-wallet";
import { useStellarContract } from "@/hooks/use-stellar";
import { useFarmPools, useFarmPositions, useFarmStats, type FarmPoolRow } from "@/hooks/use-farm";
import { fullRangeTicks } from "@/lib/pool-ticks";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Sprout, Lock, Zap, TrendingUp, Award, Info } from "lucide-react";

function boostMultiplier(weeks: number): number {
  return 1.0 + (weeks / 156) * 1.5;
}

function formatUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function formatLiquidity(raw?: string): string {
  if (!raw || raw === "0") return "0";
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  return n.toLocaleString();
}

export default function Farm() {
  const { address } = useWallet();
  const { stakeFarm, claimFarm, unstakeFarm } = useStellarContract();
  const { toast } = useToast();
  const qc = useQueryClient();

  const { tickLower, tickUpper } = fullRangeTicks();
  const [selectedPool, setSelectedPool] = useState<FarmPoolRow | null>(null);
  const [lockWeeks, setLockWeeks] = useState(52);
  const [autoCompound, setAutoCompound] = useState(false);
  const [activeTab, setActiveTab] = useState("pools");

  const { data: pools, isLoading: poolsLoading } = useFarmPools(address);
  const { data: stats } = useFarmStats(address);
  const { data: positions, isLoading: positionsLoading } = useFarmPositions(address);

  const boost = boostMultiplier(lockWeeks);
  const lockEndDate = new Date(Date.now() + lockWeeks * 7 * 24 * 60 * 60 * 1000);

  useEffect(() => {
    if (pools && pools.length > 0 && !selectedPool) setSelectedPool(pools[0]);
  }, [pools, selectedPool]);

  const invalidateFarm = () => {
    qc.invalidateQueries({ queryKey: ["farm-pools"] });
    qc.invalidateQueries({ queryKey: ["farm-stats"] });
    qc.invalidateQueries({ queryKey: ["farm-positions"] });
  };

  const stakeMutation = useMutation({
    mutationFn: async () => {
      if (!selectedPool?.poolContract) throw new Error("Select a pool");
      const available = selectedPool.availableToStake ?? "0";
      if (BigInt(available) <= 0n) {
        throw new Error("No unstaked LP liquidity. Add liquidity on Pools first.");
      }
      return stakeFarm({
        poolContract: selectedPool.poolContract,
        tickLower,
        tickUpper,
        stakeMax: true,
        lockWeeks,
        autoCompound,
      });
    },
    onSuccess: (hash) => {
      toast({ title: "Position staked!", description: `Tx: ${hash.slice(0, 16)}…` });
      invalidateFarm();
      setActiveTab("positions");
    },
    onError: (e: Error) => toast({ title: "Stake failed", description: e.message, variant: "destructive" }),
  });

  const claimMutation = useMutation({
    mutationFn: async (poolContract: string) =>
      claimFarm({ poolContract, tickLower, tickUpper }),
    onSuccess: (hash) => {
      toast({ title: "Rewards claimed!", description: `Tx: ${hash.slice(0, 16)}…` });
      invalidateFarm();
    },
    onError: (e: Error) => toast({ title: "Claim failed", description: e.message, variant: "destructive" }),
  });

  const unstakeMutation = useMutation({
    mutationFn: async (poolContract: string) =>
      unstakeFarm({ poolContract, tickLower, tickUpper, unstakeMax: true }),
    onSuccess: (hash) => {
      toast({ title: "Unstaked!", description: `Tx: ${hash.slice(0, 16)}…` });
      invalidateFarm();
    },
    onError: (e: Error) => toast({ title: "Unstake failed", description: e.message, variant: "destructive" }),
  });

  const headerStats = [
    {
      label: "Farm Pools",
      value: stats ? String(stats.poolCount) : "—",
      icon: <TrendingUp className="w-4 h-4" />,
    },
    {
      label: "Weekly STELLAR",
      value: stats ? stats.totalWeeklyStellar.toLocaleString(undefined, { maximumFractionDigits: 0 }) : "—",
      icon: <Sprout className="w-4 h-4" />,
    },
    {
      label: "Max Boost",
      value: stats ? `${stats.maxBoost}×` : "2.5×",
      icon: <Zap className="w-4 h-4" />,
    },
    {
      label: "Your Rewards",
      value: !address
        ? "Connect wallet"
        : stats?.userPendingRewards != null
          ? `${stats.userPendingRewards.toFixed(4)} STELLAR`
          : "0 STELLAR",
      icon: <Award className="w-4 h-4" />,
    },
  ];

  return (
    <div className="container mx-auto px-4 py-8 max-w-6xl">
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-green-500 to-emerald-600 flex items-center justify-center">
            <Sprout className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Liquidity Farm</h1>
            <p className="text-sm text-muted-foreground">Stake concentrated LP positions • Earn STELLAR rewards</p>
          </div>
          <Badge variant="outline" className="ml-auto text-xs border-green-500/40 text-green-400">
            Live on-chain
          </Badge>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6">
          {headerStats.map((s) => (
            <Card key={s.label} className="bg-card/60 border-border/50 backdrop-blur">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-muted-foreground mb-1">
                  {s.icon}
                  <span className="text-xs">{s.label}</span>
                </div>
                <p className="text-lg font-bold">{s.value}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="mb-6">
          <TabsTrigger value="pools">Farm Pools</TabsTrigger>
          <TabsTrigger value="stake">Stake Position</TabsTrigger>
          <TabsTrigger value="positions">My Positions</TabsTrigger>
        </TabsList>

        <TabsContent value="pools">
          {poolsLoading ? (
            <div className="space-y-4">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-24 w-full rounded-xl" />
              ))}
            </div>
          ) : !pools?.length ? (
            <Card className="bg-card/60 border-border/50 backdrop-blur">
              <CardContent className="py-12 text-center text-muted-foreground">
                No on-chain farm pools found. Deploy contracts and seed liquidity first.
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4">
              {pools.map((pool) => (
                <Card
                  key={pool.poolContract}
                  className="bg-card/60 border-border/50 backdrop-blur hover:border-primary/30 transition-all cursor-pointer"
                  onClick={() => {
                    setSelectedPool(pool);
                    setActiveTab("stake");
                  }}
                >
                  <CardContent className="p-5">
                    <div className="flex items-center justify-between flex-wrap gap-4">
                      <div className="flex items-center gap-3">
                        <div className="flex -space-x-2">
                          <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-xs font-bold border-2 border-background z-10">
                            {pool.token0Symbol.slice(0, 2)}
                          </div>
                          <div className="w-9 h-9 rounded-full bg-gradient-to-br from-orange-500 to-red-600 flex items-center justify-center text-white text-xs font-bold border-2 border-background">
                            {pool.token1Symbol.slice(0, 2)}
                          </div>
                        </div>
                        <div>
                          <p className="font-semibold">{pool.pair}</p>
                          <p className="text-xs text-muted-foreground">Concentrated Liquidity Farm</p>
                        </div>
                      </div>

                      <div className="hidden md:flex items-center gap-8">
                        <div className="text-right">
                          <p className="text-xs text-muted-foreground">TVL</p>
                          <p className="font-semibold">{formatUsd(pool.tvlUsd)}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-xs text-muted-foreground">Weekly STELLAR</p>
                          <p className="font-semibold">
                            {pool.farm.weeklyStellarHuman.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="text-xs text-muted-foreground">Base APR</p>
                          <p className="font-bold text-green-500">{pool.farm.baseAprPercent.toFixed(2)}%</p>
                        </div>
                        <div className="text-right">
                          <p className="text-xs text-muted-foreground">Max APR (2.5×)</p>
                          <p className="font-bold text-emerald-400">
                            {(pool.farm.baseAprPercent * 2.5).toFixed(2)}%
                          </p>
                        </div>
                      </div>

                      <Button size="sm" variant="outline" className="rounded-full">
                        Stake →
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="stake">
          {!selectedPool || !pools?.length ? (
            <Card className="bg-card/60 border-border/50 backdrop-blur">
              <CardContent className="py-12 text-center text-muted-foreground">
                No on-chain farm pools available. Deploy contracts and create a pool first.
              </CardContent>
            </Card>
          ) : (
            <div className="grid md:grid-cols-2 gap-6">
              <Card className="bg-card/60 border-border/50 backdrop-blur">
                <CardHeader>
                  <CardTitle className="text-lg">Stake in {selectedPool.pair}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-5">
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">Pool</Label>
                    <div className="grid grid-cols-2 gap-2 max-h-40 overflow-y-auto">
                      {pools.map((p) => (
                        <Button
                          key={p.poolContract}
                          variant={selectedPool.poolContract === p.poolContract ? "default" : "outline"}
                          size="sm"
                          className="text-xs rounded-lg justify-start"
                          onClick={() => setSelectedPool(p)}
                        >
                          {p.pair}
                        </Button>
                      ))}
                    </div>
                  </div>

                  <div className="p-3 rounded-lg bg-muted/30 border border-border/50 space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Your LP liquidity</span>
                      <span className="font-mono">{formatLiquidity(selectedPool.lpLiquidity)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Already staked</span>
                      <span className="font-mono">{formatLiquidity(selectedPool.stakedLiquidity)}</span>
                    </div>
                    <div className="flex justify-between font-medium">
                      <span>Available to stake</span>
                      <span className="font-mono text-green-400">
                        {formatLiquidity(selectedPool.availableToStake)}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground pt-1">
                      Full-range ticks ({tickLower} … {tickUpper}). Add liquidity on Pools if available is 0.
                    </p>
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs text-muted-foreground flex items-center gap-1">
                        <Lock className="w-3 h-3" /> Lock Duration
                      </Label>
                      <span className="text-sm font-semibold text-primary">{lockWeeks} weeks</span>
                    </div>
                    <Slider
                      min={1}
                      max={156}
                      step={1}
                      value={[lockWeeks]}
                      onValueChange={([v]) => setLockWeeks(v)}
                      className="w-full"
                    />
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>1 week</span>
                      <span>1 year</span>
                      <span>3 years</span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between p-3 rounded-lg bg-muted/30 border border-border/50">
                    <div>
                      <p className="text-sm font-medium flex items-center gap-1">
                        <Zap className="w-3.5 h-3.5 text-yellow-500" /> Auto-compound
                      </p>
                      <p className="text-xs text-muted-foreground">Reinvest fees + rewards automatically</p>
                    </div>
                    <Switch checked={autoCompound} onCheckedChange={setAutoCompound} />
                  </div>

                  <Button
                    className="w-full bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-500 hover:to-emerald-500 text-white font-semibold"
                    disabled={
                      !address ||
                      stakeMutation.isPending ||
                      BigInt(selectedPool.availableToStake ?? "0") <= 0n
                    }
                    onClick={() => stakeMutation.mutate()}
                  >
                    {!address
                      ? "Connect Wallet"
                      : stakeMutation.isPending
                        ? "Staking…"
                        : BigInt(selectedPool.availableToStake ?? "0") <= 0n
                          ? "No LP to stake"
                          : "Stake full available LP"}
                  </Button>
                </CardContent>
              </Card>

              <div className="space-y-4">
                <Card className="bg-card/60 border-border/50 backdrop-blur">
                  <CardContent className="p-5 space-y-4">
                    <h3 className="font-semibold flex items-center gap-2">
                      <Zap className="w-4 h-4 text-yellow-500" /> veToken Boost
                    </h3>
                    <div className="relative h-3 rounded-full bg-muted overflow-hidden">
                      <div
                        className="absolute left-0 top-0 h-full rounded-full bg-gradient-to-r from-yellow-500 to-orange-500 transition-all"
                        style={{ width: `${((boost - 1) / 1.5) * 100}%` }}
                      />
                    </div>
                    <div className="flex justify-between items-end">
                      <div>
                        <p className="text-3xl font-bold text-orange-400">{boost.toFixed(2)}×</p>
                        <p className="text-xs text-muted-foreground">Boost multiplier</p>
                      </div>
                      <div className="text-right">
                        <p className="text-lg font-semibold text-green-400">
                          {(selectedPool.farm.baseAprPercent * boost).toFixed(2)}%
                        </p>
                        <p className="text-xs text-muted-foreground">Effective APR</p>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3 pt-2 border-t border-border/50">
                      {[
                        { label: "Lock ends", value: lockEndDate.toLocaleDateString() },
                        { label: "Base APR", value: `${selectedPool.farm.baseAprPercent.toFixed(2)}%` },
                        {
                          label: "Boosted APR",
                          value: `${(selectedPool.farm.baseAprPercent * boost).toFixed(2)}%`,
                        },
                        {
                          label: "Weekly pool emissions",
                          value: `${selectedPool.farm.weeklyStellarHuman.toFixed(2)} STELLAR`,
                        },
                      ].map((item) => (
                        <div key={item.label} className="p-3 rounded-lg bg-muted/20">
                          <p className="text-xs text-muted-foreground">{item.label}</p>
                          <p className="text-sm font-semibold mt-1">{item.value}</p>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>

                <Card className="bg-card/60 border-border/50 backdrop-blur">
                  <CardContent className="p-5">
                    <h3 className="font-semibold flex items-center gap-2 mb-3">
                      <Info className="w-4 h-4 text-blue-400" /> How Boosted Farming Works
                    </h3>
                    <ul className="space-y-2 text-xs text-muted-foreground">
                      <li>1. Add liquidity on Pools (full-range position).</li>
                      <li>2. Stake your LP into the farm with a lock for up to 2.5× rewards.</li>
                      <li>3. Claim STELLAR anytime; unstake after your lock expires.</li>
                    </ul>
                  </CardContent>
                </Card>
              </div>
            </div>
          )}
        </TabsContent>

        <TabsContent value="positions">
          {!address ? (
            <Card className="bg-card/60 border-border/50 backdrop-blur">
              <CardContent className="py-16 text-center">
                <Sprout className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
                <p className="text-lg font-medium mb-2">Connect your wallet</p>
                <p className="text-sm text-muted-foreground">Connect to see your staked positions</p>
              </CardContent>
            </Card>
          ) : positionsLoading ? (
            <Skeleton className="h-32 w-full rounded-xl" />
          ) : !positions?.length ? (
            <Card className="bg-card/60 border-border/50 backdrop-blur">
              <CardContent className="py-12 text-center">
                <p className="text-muted-foreground">No active farm positions. Stake LP to start earning.</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {positions.map((pos) => (
                <Card key={pos.poolContract} className="bg-card/60 border-border/50 backdrop-blur">
                  <CardContent className="p-5">
                    <div className="flex flex-wrap items-center justify-between gap-4">
                      <div>
                        <p className="font-semibold text-lg">{pos.pair}</p>
                        <p className="text-sm text-muted-foreground">
                          Staked: {formatLiquidity(pos.stake.liquidity)} LP • {pos.stake.lockWeeks}w lock •{" "}
                          {pos.stake.boostMultiplier.toFixed(2)}× boost
                        </p>
                        <p className="text-sm text-green-400 mt-1">
                          Pending: {pos.pendingRewardsHuman.toFixed(4)} STELLAR
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={claimMutation.isPending || pos.pendingRewardsHuman <= 0}
                          onClick={() => claimMutation.mutate(pos.poolContract)}
                        >
                          Claim
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={unstakeMutation.isPending}
                          onClick={() => unstakeMutation.mutate(pos.poolContract)}
                        >
                          Unstake
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
