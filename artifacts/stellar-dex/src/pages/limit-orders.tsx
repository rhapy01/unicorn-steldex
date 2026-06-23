import { useState, useMemo } from "react";
import { useWallet } from "@/hooks/use-wallet";
import { useStellarContract } from "@/hooks/use-stellar";
import { useWalletOrders, useOrderBook } from "@/hooks/use-limit-orders";
import { useContracts } from "@/hooks/use-contracts";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { parseTokenAmount, tokenDecimals, resolvePoolContract } from "@/lib/onchain";
import { Target, ArrowRight, Clock, CheckCircle2, XCircle, AlertCircle } from "lucide-react";

interface Token {
  id: number;
  symbol: string;
  name: string;
  price: number;
  logoUrl?: string;
  contractAddress?: string;
}

const ORDER_TYPES = ["Limit", "Stop-Loss", "Take-Profit"] as const;
type OrderType = typeof ORDER_TYPES[number];

function PriceDistanceBar({ limitPrice, currentPrice }: { limitPrice: number; currentPrice: number }) {
  const pct = currentPrice > 0 ? ((limitPrice - currentPrice) / currentPrice) * 100 : 0;
  const abs = Math.abs(pct);
  const color = pct > 0 ? "bg-green-500" : "bg-red-500";
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">Distance to fill</span>
        <span className={pct > 0 ? "text-green-500" : "text-red-500"}>
          {pct > 0 ? "+" : ""}{pct.toFixed(2)}%
        </span>
      </div>
      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color} transition-all`} style={{ width: `${Math.min(abs, 100)}%` }} />
      </div>
    </div>
  );
}

function OrderStatusBadge({ status }: { status: "pending" | "filled" | "expired" | "cancelled" }) {
  const map = {
    pending: { label: "Pending", icon: <Clock className="w-3 h-3" />, variant: "secondary" as const },
    filled: { label: "Filled", icon: <CheckCircle2 className="w-3 h-3" />, variant: "default" as const },
    expired: { label: "Expired", icon: <AlertCircle className="w-3 h-3" />, variant: "outline" as const },
    cancelled: { label: "Cancelled", icon: <XCircle className="w-3 h-3" />, variant: "destructive" as const },
  };
  const m = map[status];
  return (
    <Badge variant={m.variant} className="gap-1 text-xs">
      {m.icon}{m.label}
    </Badge>
  );
}

export default function LimitOrders() {
  const { address } = useWallet();
  const { placeLimitOrder, cancelOrder } = useStellarContract();
  const { data: contracts } = useContracts();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [orderType, setOrderType] = useState<OrderType>("Limit");
  const [fromSymbol, setFromSymbol] = useState("XLM");
  const [toSymbol, setToSymbol] = useState("pUSDC");
  const [fromAmount, setFromAmount] = useState("");
  const [limitPrice, setLimitPrice] = useState("");
  const [expiryHours, setExpiryHours] = useState("72");
  const [activeTab, setActiveTab] = useState("place");

  const { data: tokens = [] } = useQuery<Token[]>({
    queryKey: ["tokens"],
    queryFn: () => fetch("/api/tokens").then((r) => r.json()),
  });

  const poolContract = useMemo(
    () => resolvePoolContract(fromSymbol, toSymbol, contracts ?? undefined),
    [fromSymbol, toSymbol, contracts],
  );

  const { data: myOrders = [], isLoading: ordersLoading } = useWalletOrders(address);
  const { data: orderBook } = useOrderBook(poolContract ?? undefined, fromSymbol, toSymbol);

  const selectedFrom = tokens.find((t) => t.symbol === fromSymbol);
  const selectedTo = tokens.find((t) => t.symbol === toSymbol);
  const currentPrice = selectedFrom && selectedTo ? selectedFrom.price / selectedTo.price : orderBook?.currentPrice ?? 0;
  const toAmount = fromAmount && limitPrice
    ? (parseFloat(fromAmount) * parseFloat(limitPrice)).toFixed(6)
    : "";
  const priceVsCurrent = limitPrice && currentPrice
    ? ((parseFloat(limitPrice) - currentPrice) / currentPrice * 100)
    : 0;

  const likelyResting =
    orderType !== "Limit" || priceVsCurrent > 0;

  const placeMutation = useMutation({
    mutationFn: async () => {
      if (!fromAmount || !limitPrice) throw new Error("Fill all fields");
      const fromToken = tokens.find((t) => t.symbol === fromSymbol);
      const toToken = tokens.find((t) => t.symbol === toSymbol);
      const fromContract = fromToken?.contractAddress;
      const toContract = toToken?.contractAddress;
      if (!fromContract || !toContract)
        throw new Error("Token contract not available — deploy contracts or use XLM/pUSDC");

      return placeLimitOrder({
        fromContract,
        toContract,
        amount: parseTokenAmount(fromAmount, tokenDecimals(fromSymbol)).toString(),
        limitPrice: parseTokenAmount(limitPrice, tokenDecimals(toSymbol)).toString(),
        orderType,
        expiryHours: expiryHours === "0" ? 0 : Number(expiryHours),
      });
    },
    onSuccess: (hash) => {
      toast({
        title: likelyResting ? "Resting order placed" : "Limit order filled",
        description: likelyResting
          ? `Order escrowed on-chain. Tx: ${hash.slice(0, 16)}…`
          : `Swap executed at your limit. Tx: ${hash.slice(0, 16)}…`,
      });
      setFromAmount("");
      setLimitPrice("");
      qc.invalidateQueries({ queryKey: ["limit-orders"] });
      qc.invalidateQueries({ queryKey: ["order-book"] });
      if (likelyResting) setActiveTab("orders");
    },
    onError: (e: Error) => toast({ title: "Order failed", description: e.message, variant: "destructive" }),
  });

  const cancelMutation = useMutation({
    mutationFn: (orderId: string) => cancelOrder({ orderId }),
    onSuccess: (hash) => {
      toast({ title: "Order cancelled", description: `Tx: ${hash.slice(0, 16)}…` });
      qc.invalidateQueries({ queryKey: ["limit-orders"] });
      qc.invalidateQueries({ queryKey: ["order-book"] });
    },
    onError: (e: Error) => toast({ title: "Cancel failed", description: e.message, variant: "destructive" }),
  });

  const swapTokens = () => {
    setFromSymbol(toSymbol);
    setToSymbol(fromSymbol);
  };

  const bookToSymbol = toSymbol === "USDC" ? "pUSDC" : toSymbol;

  return (
    <div className="container mx-auto px-4 py-8 max-w-6xl">
      <div className="flex items-center gap-3 mb-8">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-orange-500 to-red-600 flex items-center justify-center">
          <Target className="w-5 h-5 text-white" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">Limit Orders</h1>
          <p className="text-sm text-muted-foreground">On-chain resting orders with immediate fill when price is met</p>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="mb-6">
          <TabsTrigger value="place">Place Order</TabsTrigger>
          <TabsTrigger value="orders">My Orders</TabsTrigger>
          <TabsTrigger value="orderbook">Order Book</TabsTrigger>
        </TabsList>

        <TabsContent value="place">
          <div className="grid md:grid-cols-2 gap-6">
            <Card className="bg-card/60 border-border/50 backdrop-blur">
              <CardHeader>
                <CardTitle className="text-lg">New {orderType} Order</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex gap-2">
                  {ORDER_TYPES.map((t) => (
                    <Button
                      key={t}
                      size="sm"
                      variant={orderType === t ? "default" : "outline"}
                      className="text-xs rounded-full"
                      onClick={() => setOrderType(t)}
                    >
                      {t}
                    </Button>
                  ))}
                </div>

                <div className="p-4 rounded-xl bg-muted/30 border border-border/50 space-y-3">
                  <Label className="text-xs text-muted-foreground">You Pay</Label>
                  <div className="flex items-center gap-3">
                    <Select value={fromSymbol} onValueChange={setFromSymbol}>
                      <SelectTrigger className="w-32 h-10 rounded-xl border-border/50">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {tokens.map((t) => (
                          <SelectItem key={t.symbol} value={t.symbol}>{t.symbol}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      type="number"
                      placeholder="0.00"
                      value={fromAmount}
                      onChange={(e) => setFromAmount(e.target.value)}
                      className="flex-1 bg-transparent border-none text-right text-xl font-semibold p-0 focus-visible:ring-0 h-10"
                    />
                  </div>
                </div>

                <div className="flex justify-center">
                  <Button variant="ghost" size="icon" className="rounded-full border border-border/50 h-8 w-8" onClick={swapTokens}>
                    <ArrowRight className="w-4 h-4" />
                  </Button>
                </div>

                <div className="p-4 rounded-xl bg-muted/30 border border-border/50 space-y-3">
                  <Label className="text-xs text-muted-foreground">You Receive (min)</Label>
                  <div className="flex items-center gap-3">
                    <Select value={toSymbol} onValueChange={setToSymbol}>
                      <SelectTrigger className="w-32 h-10 rounded-xl border-border/50">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {tokens.map((t) => (
                          <SelectItem key={t.symbol} value={t.symbol}>{t.symbol}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="flex-1 text-right text-xl font-semibold text-muted-foreground">
                      {toAmount || "0.00"}
                    </p>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-muted-foreground">
                      {orderType === "Limit" ? "Limit Price" : orderType === "Stop-Loss" ? "Stop Price" : "Target Price"}
                    </Label>
                    <button
                      type="button"
                      className="text-xs text-primary hover:underline"
                      onClick={() => setLimitPrice(currentPrice.toFixed(6))}
                    >
                      Market: {currentPrice.toFixed(6)}
                    </button>
                  </div>
                  <div className="relative">
                    <Input
                      type="number"
                      placeholder={currentPrice.toFixed(6)}
                      value={limitPrice}
                      onChange={(e) => setLimitPrice(e.target.value)}
                      className="pr-24 font-mono"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                      {toSymbol}/{fromSymbol}
                    </span>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">Order Expiry</Label>
                  <Select value={expiryHours} onValueChange={setExpiryHours}>
                    <SelectTrigger className="rounded-xl">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="24">24 hours</SelectItem>
                      <SelectItem value="72">3 days</SelectItem>
                      <SelectItem value="168">1 week</SelectItem>
                      <SelectItem value="720">30 days</SelectItem>
                      <SelectItem value="0">Never</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <Button
                  className="w-full bg-gradient-to-r from-orange-600 to-red-600 hover:from-orange-500 hover:to-red-500 text-white font-semibold"
                  disabled={!address || !fromAmount || !limitPrice || placeMutation.isPending || !poolContract}
                  onClick={() => placeMutation.mutate()}
                >
                  {!address ? "Connect Wallet" : !poolContract ? "No pool for pair" : placeMutation.isPending ? "Placing..." : `Place ${orderType} Order`}
                </Button>
              </CardContent>
            </Card>

            <div className="space-y-4">
              {fromAmount && limitPrice && (
                <Card className="bg-card/60 border-border/50 backdrop-blur">
                  <CardContent className="p-5 space-y-3">
                    <h3 className="font-semibold">Order Summary</h3>
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Type</span>
                        <span>{likelyResting ? "Resting (on-chain)" : "Immediate fill"}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">You sell</span>
                        <span>{fromAmount} {fromSymbol}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Min receive</span>
                        <span>≥ {toAmount} {toSymbol}</span>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}

              <Card className="bg-card/60 border-border/50 backdrop-blur">
                <CardContent className="p-5">
                  <h3 className="font-semibold mb-3">How It Works</h3>
                  <ul className="space-y-2 text-xs text-muted-foreground">
                    <li><strong>Limit:</strong> Fills when the pool price crosses your trigger (or immediately if already favorable).</li>
                    <li><strong>Stop-Loss:</strong> Sells when price falls to your stop.</li>
                    <li><strong>Take-Profit:</strong> Sells when price rises to your target.</li>
                    <li>Tokens are escrowed on-chain until fill, cancel, or expiry (auto-refund).</li>
                    <li>A background keeper fills orders when price triggers and processes expirations.</li>
                  </ul>
                </CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="orders">
          {!address ? (
            <Card className="bg-card/60 border-border/50 backdrop-blur">
              <CardContent className="py-16 text-center">
                <p className="text-sm text-muted-foreground">Connect wallet to view open orders</p>
              </CardContent>
            </Card>
          ) : ordersLoading ? (
            <p className="text-sm text-muted-foreground text-center py-12">Loading orders…</p>
          ) : myOrders.length === 0 ? (
            <Card className="bg-card/60 border-border/50 backdrop-blur">
              <CardContent className="py-12 text-center text-muted-foreground text-sm">
                No open resting orders. Place a limit above market, stop-loss, or take-profit to escrow on-chain.
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {myOrders.map((order) => (
                <Card key={order.id} className="bg-card/60 border-border/50 backdrop-blur">
                  <CardContent className="p-5">
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold">{order.fromSymbol} → {order.toSymbol}</span>
                          <Badge variant="outline" className="text-xs">{order.orderType}</Badge>
                          <OrderStatusBadge status={order.status} />
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">
                          {order.fromAmount} {order.fromSymbol} • min {order.toAmountMin} {order.toSymbol}
                          {order.expiryLedger > 0 && (
                            <>
                              {" • "}
                              {order.status === "expired"
                                ? "Expired — refund pending"
                                : `Expires in ~${(order.expiresInLedgers / 300).toFixed(1)}h`}
                            </>
                          )}
                        </p>
                      </div>
                      <div className="flex items-center gap-4">
                        <div className="text-sm">
                          <p className="text-xs text-muted-foreground">Trigger</p>
                          <p className="font-mono">{order.limitPrice.toFixed(6)}</p>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-red-500"
                          disabled={cancelMutation.isPending || order.status === "expired"}
                          onClick={() => cancelMutation.mutate(order.id)}
                        >
                          {order.status === "expired" ? "Refunding…" : "Cancel"}
                        </Button>
                      </div>
                    </div>
                    <div className="mt-3 pt-3 border-t border-border/50">
                      <PriceDistanceBar limitPrice={order.limitPrice} currentPrice={order.currentPrice} />
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="orderbook">
          {!poolContract ? (
            <Card className="bg-card/60 border-border/50 backdrop-blur">
              <CardContent className="py-12 text-center text-muted-foreground text-sm">
                Select a token pair with an on-chain pool to view the order book.
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="grid md:grid-cols-2 gap-4">
                {[
                  { side: "Sell Orders", items: orderBook?.sells ?? [], color: "text-red-400" },
                  { side: "Buy Orders", items: orderBook?.buys ?? [], color: "text-green-400" },
                ].map(({ side, items, color }) => (
                  <Card key={side} className="bg-card/60 border-border/50 backdrop-blur">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">{side}</CardTitle>
                    </CardHeader>
                    <CardContent className="p-0">
                      <div className="grid grid-cols-4 px-4 py-2 border-b border-border/50 text-xs text-muted-foreground">
                        <span>Price ({bookToSymbol})</span>
                        <span className="text-right">Size ({fromSymbol})</span>
                        <span className="text-right">Depth</span>
                        <span className="text-right">Orders</span>
                      </div>
                      {items.length === 0 ? (
                        <p className="px-4 py-8 text-center text-xs text-muted-foreground">No open orders</p>
                      ) : (
                        items.map((item) => (
                          <div key={item.orderId} className="grid grid-cols-4 px-4 py-2 text-sm hover:bg-muted/20">
                            <span className={`font-mono font-medium ${color}`}>{item.price.toFixed(6)}</span>
                            <span className="text-right font-mono">{item.amount.toLocaleString()}</span>
                            <span className="text-right font-mono text-muted-foreground">{item.cumulative.toLocaleString()}</span>
                            <span className="text-right font-mono text-xs text-muted-foreground">{item.orderCount}</span>
                          </div>
                        ))
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
              {orderBook && (
                <div className="mt-4 p-3 rounded-xl bg-muted/20 border border-border/50 text-center text-sm space-y-1">
                  <div>
                    <span className="text-muted-foreground">Market: </span>
                    <span className="font-mono font-semibold">{orderBook.currentPrice.toFixed(6)}</span>
                    {orderBook.spread > 0 && (
                      <>
                        <span className="text-muted-foreground"> • Spread: </span>
                        <span className="text-orange-400 font-bold">{orderBook.spread.toFixed(6)}</span>
                      </>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Book depth — sells: {orderBook.sellDepth.toLocaleString()} {fromSymbol}
                    {" • "}
                    buys: {orderBook.buyDepth.toLocaleString()} {fromSymbol}
                  </div>
                </div>
              )}
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
