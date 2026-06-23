import React from "react";
import { useListTokens, useListPools, useGetMarketStats } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

export default function Explore() {
  const { data: stats, isLoading: isStatsLoading } = useGetMarketStats();
  const { data: tokens, isLoading: isTokensLoading } = useListTokens();
  const { data: pools, isLoading: isPoolsLoading } = useListPools({ sortBy: 'tvl' });

  const formatCurrency = (val: number) => {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(val);
  };

  const formatPercent = (val: number) => {
    return `${val >= 0 ? '+' : ''}${val.toFixed(2)}%`;
  };

  return (
    <div className="container mx-auto p-4 md:p-8 space-y-8 animate-in fade-in duration-500">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">Explore Market</h1>
        <p className="text-muted-foreground">Global data across the StellarSwap protocol.</p>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="glass-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Value Locked</CardTitle>
          </CardHeader>
          <CardContent>
            {isStatsLoading ? <Skeleton className="h-8 w-32" /> : (
              <div className="flex flex-col gap-1">
                <div className="text-2xl font-bold font-mono">{formatCurrency(stats?.totalTvl || 0)}</div>
                <div className={`text-sm ${stats?.tvlChange24h && stats.tvlChange24h >= 0 ? 'text-green-500' : 'text-destructive'}`}>
                  {stats?.tvlChange24h ? formatPercent(stats.tvlChange24h) : '0.00%'}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
        
        <Card className="glass-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">24h Volume</CardTitle>
          </CardHeader>
          <CardContent>
            {isStatsLoading ? <Skeleton className="h-8 w-32" /> : (
              <div className="flex flex-col gap-1">
                <div className="text-2xl font-bold font-mono">{formatCurrency(stats?.volume24h || 0)}</div>
                <div className={`text-sm ${stats?.volumeChange24h && stats.volumeChange24h >= 0 ? 'text-green-500' : 'text-destructive'}`}>
                  {stats?.volumeChange24h ? formatPercent(stats.volumeChange24h) : '0.00%'}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="glass-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Pools</CardTitle>
          </CardHeader>
          <CardContent>
            {isStatsLoading ? <Skeleton className="h-8 w-16" /> : (
              <div className="text-2xl font-bold font-mono">{stats?.totalPools || 0}</div>
            )}
          </CardContent>
        </Card>

        <Card className="glass-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">24h Transactions</CardTitle>
          </CardHeader>
          <CardContent>
            {isStatsLoading ? <Skeleton className="h-8 w-24" /> : (
              <div className="text-2xl font-bold font-mono">{stats?.totalTransactions24h?.toLocaleString() || 0}</div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Top Tokens */}
      <div className="space-y-4">
        <h2 className="text-xl font-bold">Top Tokens</h2>
        <div className="rounded-xl border bg-card/50 backdrop-blur overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[50px]">#</TableHead>
                <TableHead>Token Name</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead className="text-right">Change (24h)</TableHead>
                <TableHead className="text-right">Volume (24h)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isTokensLoading ? (
                Array(5).fill(0).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell><Skeleton className="h-4 w-4" /></TableCell>
                    <TableCell><Skeleton className="h-6 w-32" /></TableCell>
                    <TableCell className="text-right"><Skeleton className="h-4 w-16 ml-auto" /></TableCell>
                    <TableCell className="text-right"><Skeleton className="h-4 w-16 ml-auto" /></TableCell>
                    <TableCell className="text-right"><Skeleton className="h-4 w-24 ml-auto" /></TableCell>
                  </TableRow>
                ))
              ) : tokens?.map((token, index) => (
                <TableRow key={token.id} className="cursor-pointer hover:bg-muted/50 transition-colors">
                  <TableCell className="text-muted-foreground">{index + 1}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      {token.logoUrl ? (
                        <img src={token.logoUrl} alt={token.symbol} className="w-8 h-8 rounded-full" />
                      ) : (
                        <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center font-bold text-xs">{token.symbol[0]}</div>
                      )}
                      <div className="flex flex-col">
                        <span className="font-bold flex items-center gap-2">
                          {token.symbol}
                          {token.isNative && <Badge variant="secondary" className="text-[10px] h-4 px-1">Native</Badge>}
                        </span>
                        <span className="text-xs text-muted-foreground">{token.name}</span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-mono">{formatCurrency(token.price)}</TableCell>
                  <TableCell className={`text-right font-medium ${token.change24h >= 0 ? 'text-green-500' : 'text-destructive'}`}>
                    {formatPercent(token.change24h)}
                  </TableCell>
                  <TableCell className="text-right font-mono">{formatCurrency(token.volume24h)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Top Pools */}
      <div className="space-y-4">
        <h2 className="text-xl font-bold">Top Pools</h2>
        <div className="rounded-xl border bg-card/50 backdrop-blur overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[50px]">#</TableHead>
                <TableHead>Pool</TableHead>
                <TableHead className="text-right">TVL</TableHead>
                <TableHead className="text-right">Volume (24h)</TableHead>
                <TableHead className="text-right">Fees (24h)</TableHead>
                <TableHead className="text-right">APY</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isPoolsLoading ? (
                Array(5).fill(0).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell><Skeleton className="h-4 w-4" /></TableCell>
                    <TableCell><Skeleton className="h-6 w-32" /></TableCell>
                    <TableCell className="text-right"><Skeleton className="h-4 w-20 ml-auto" /></TableCell>
                    <TableCell className="text-right"><Skeleton className="h-4 w-20 ml-auto" /></TableCell>
                    <TableCell className="text-right"><Skeleton className="h-4 w-16 ml-auto" /></TableCell>
                    <TableCell className="text-right"><Skeleton className="h-4 w-12 ml-auto" /></TableCell>
                  </TableRow>
                ))
              ) : pools?.map((pool, index) => (
                <TableRow key={pool.id} className="cursor-pointer hover:bg-muted/50 transition-colors">
                  <TableCell className="text-muted-foreground">{index + 1}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <div className="flex -space-x-2">
                        {pool.tokenA.logoUrl ? <img src={pool.tokenA.logoUrl} className="w-6 h-6 rounded-full border-2 border-background" /> : <div className="w-6 h-6 rounded-full bg-primary/20 border-2 border-background" />}
                        {pool.tokenB.logoUrl ? <img src={pool.tokenB.logoUrl} className="w-6 h-6 rounded-full border-2 border-background z-10" /> : <div className="w-6 h-6 rounded-full bg-blue-500/20 border-2 border-background z-10" />}
                      </div>
                      <span className="font-bold">{pool.tokenA.symbol} / {pool.tokenB.symbol}</span>
                      <Badge variant="outline" className="text-xs ml-2">{(pool.fee * 100).toFixed(2)}%</Badge>
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-mono">{formatCurrency(pool.totalLiquidity)}</TableCell>
                  <TableCell className="text-right font-mono">{formatCurrency(pool.volume24h)}</TableCell>
                  <TableCell className="text-right font-mono">{formatCurrency(pool.fees24h)}</TableCell>
                  <TableCell className="text-right text-green-500 font-medium">{pool.apy.toFixed(2)}%</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
