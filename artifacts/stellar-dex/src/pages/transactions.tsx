import React from "react";
import { useListTransactions } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { ArrowRightLeft, ArrowDownToLine, ArrowUpFromLine, ExternalLink, Radio } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useStellarEvents } from "@/hooks/use-stellar-events";

export default function Transactions() {
  const { data: transactions, isLoading } = useListTransactions({ limit: 50 });
  const { events, isConnected } = useStellarEvents();

  const formatCurrency = (val: number | null | undefined) => {
    if (val === null || val === undefined) return '-';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(val);
  };

  const formatAddress = (addr: string) => {
    if (!addr) return "";
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  };

  return (
    <div className="container mx-auto p-4 md:p-8 space-y-8 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-bold tracking-tight">Global Activity</h1>
          <p className="text-muted-foreground">Real-time transaction history across all pools.</p>
        </div>
        <Badge variant={isConnected ? "default" : "secondary"} className="w-fit gap-1.5">
          <Radio className={`h-3 w-3 ${isConnected ? "animate-pulse" : ""}`} />
          {isConnected ? "Live" : "Connecting…"}
        </Badge>
      </div>

      {events.length > 0 && (
        <Card className="glass-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">On-chain stream</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 max-h-32 overflow-y-auto">
            {events.slice(0, 5).map((ev, i) => (
              <div key={`${ev.timestamp}-${i}`} className="flex items-center justify-between text-sm">
                <span className="capitalize text-muted-foreground">{ev.type}</span>
                {ev.hash && (
                  <a
                    href={`https://stellar.expert/explorer/testnet/tx/${ev.hash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-xs hover:text-primary flex items-center gap-1"
                  >
                    {ev.hash.slice(0, 8)}… <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card className="glass-card overflow-hidden">
        <CardHeader className="border-b border-border/50 bg-muted/20">
          <CardTitle className="text-lg">Recent Transactions</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Type</TableHead>
                  <TableHead>Details</TableHead>
                  <TableHead>Value</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead>Time</TableHead>
                  <TableHead className="text-right">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  Array(10).fill(0).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell><Skeleton className="h-6 w-24" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-48" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-20" /></TableCell>
                      <TableCell className="text-right"><Skeleton className="h-6 w-16 ml-auto" /></TableCell>
                    </TableRow>
                  ))
                ) : transactions?.map((tx) => (
                  <TableRow key={tx.id} className="hover:bg-muted/50 transition-colors">
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                          tx.type === 'swap' ? 'bg-primary/20 text-primary' : 
                          tx.type === 'add_liquidity' ? 'bg-green-500/20 text-green-500' : 'bg-red-500/20 text-red-500'
                        }`}>
                          {tx.type === 'swap' ? <ArrowRightLeft className="w-4 h-4" /> : 
                           tx.type === 'add_liquidity' ? <ArrowDownToLine className="w-4 h-4" /> : <ArrowUpFromLine className="w-4 h-4" />}
                        </div>
                        <span className="capitalize font-medium text-sm hidden sm:inline-block">{tx.type.replace('_', ' ')}</span>
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-sm">
                      {tx.type === 'swap' ? (
                        <span className="flex items-center gap-2">
                          {tx.amountA} {tx.tokenASymbol} <ArrowRightLeft className="w-3 h-3 text-muted-foreground mx-1" /> {tx.amountB} {tx.tokenBSymbol}
                        </span>
                      ) : (
                        <span>
                          {tx.amountA} {tx.tokenASymbol} and {tx.amountB} {tx.tokenBSymbol}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-sm">{formatCurrency(tx.valueUsd)}</TableCell>
                    <TableCell className="font-mono text-sm text-primary hover:underline cursor-pointer flex items-center gap-1">
                      {formatAddress(tx.walletAddress)} <ExternalLink className="w-3 h-3 opacity-50" />
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                      {new Date(tx.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge variant={tx.status === 'confirmed' ? 'default' : tx.status === 'pending' ? 'secondary' : 'destructive'} 
                             className={tx.status === 'confirmed' ? 'bg-green-500 hover:bg-green-600' : ''}>
                        {tx.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
