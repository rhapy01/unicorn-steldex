import React, { useState } from "react";
import { Link, useLocation } from "wouter";
import { useWallet, FREIGHTER_INSTALL_URL } from "@/hooks/use-wallet";
import { Button } from "@/components/ui/button";
import {
  Menu,
  Zap,
  ExternalLink,
  Copy,
  LogOut,
  Search,
  MoreHorizontal,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import { ContractsBanner } from "@/components/contracts-banner";
import { UniLogo } from "@/components/uni-logo";

const TESTNET_EXPLORER = "https://stellar.expert/explorer/testnet/account/";

const navLinks = [
  { href: "/", label: "Trade" },
  { href: "/explore", label: "Explore" },
  { href: "/pool", label: "Pool" },
  { href: "/portfolio", label: "Portfolio" },
];

const moreLinks = [
  { href: "/farm", label: "Farm" },
  { href: "/orders", label: "Limit orders" },
  { href: "/transactions", label: "Activity" },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { address, isConnecting, freighterInstalled, connect, disconnect } =
    useWallet();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isWalletDialogOpen, setIsWalletDialogOpen] = useState(false);
  const { toast } = useToast();

  const formatAddress = (addr: string) =>
    addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "";

  const copyAddress = () => {
    if (address) {
      navigator.clipboard.writeText(address);
      toast({ title: "Address copied" });
    }
  };

  const handleConnect = async () => {
    try {
      await connect();
      setIsWalletDialogOpen(false);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      toast({
        title: "Connection failed",
        description: msg,
        variant: "destructive",
      });
    }
  };

  const NavItems = ({ onNav }: { onNav?: () => void }) => (
    <>
      {navLinks.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className={`text-[16px] font-medium px-3 py-2 transition-colors whitespace-nowrap ${
            location === link.href
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => onNav?.()}
        >
          {link.label}
        </Link>
      ))}
    </>
  );

  return (
    <div className="min-h-[100dvh] flex flex-col uni-page-bg relative">
      {/* Bokeh gradient blobs + floating token logos */}
      <div className="uni-bokeh" aria-hidden="true">
        <div className="uni-bokeh-blob uni-bokeh-blob-1" />
        <div className="uni-bokeh-blob uni-bokeh-blob-2" />
        <div className="uni-bokeh-blob uni-bokeh-blob-3" />

        {/* Token logos scattered in background */}
        {[
          {
            src: "https://cryptologos.cc/logos/stellar-xlm-logo.png",
            size: 88,
            top: "8%",
            left: "6%",
            delay: "0s",
          },
          {
            src: "https://cryptologos.cc/logos/usd-coin-usdc-logo.png",
            size: 72,
            top: "12%",
            left: "88%",
            delay: "1.5s",
          },
          {
            src: "https://cryptologos.cc/logos/ethereum-eth-logo.png",
            size: 96,
            top: "55%",
            left: "4%",
            delay: "3s",
          },
          {
            src: "https://cryptologos.cc/logos/tether-usdt-logo.png",
            size: 68,
            top: "70%",
            left: "92%",
            delay: "0.8s",
          },
          {
            src: "https://cryptologos.cc/logos/euro-coin-eurc-logo.png",
            size: 60,
            top: "38%",
            left: "94%",
            delay: "2.2s",
          },
          {
            src: "https://cryptologos.cc/logos/stellar-xlm-logo.png",
            size: 52,
            top: "80%",
            left: "22%",
            delay: "4s",
          },
          {
            src: "https://cryptologos.cc/logos/usd-coin-usdc-logo.png",
            size: 80,
            top: "30%",
            left: "2%",
            delay: "1s",
          },
          {
            src: "https://cryptologos.cc/logos/bitcoin-btc-logo.png",
            size: 64,
            top: "62%",
            left: "78%",
            delay: "3.5s",
          },
          {
            src: "https://cryptologos.cc/logos/ethereum-eth-logo.png",
            size: 56,
            top: "18%",
            left: "50%",
            delay: "2.8s",
          },
          {
            src: "https://cryptologos.cc/logos/tether-usdt-logo.png",
            size: 76,
            top: "85%",
            left: "58%",
            delay: "1.8s",
          },
        ].map((t, i) => (
          <img
            key={i}
            src={t.src}
            alt=""
            draggable={false}
            className="uni-token-float"
            style={{
              width: t.size,
              height: t.size,
              top: t.top,
              left: t.left,
              animationDelay: t.delay,
              animationDuration: `${6 + (i % 3) * 2}s`,
            }}
          />
        ))}
      </div>

      <ContractsBanner />

      <header className="sticky top-0 z-50 bg-white/60 backdrop-blur-2xl border-b border-black/[0.06] shadow-sm">
        <div className="max-w-[1200px] mx-auto px-4 h-[72px] flex items-center justify-between gap-4">
          <div className="flex items-center gap-8">
            <Link href="/" className="flex items-center gap-2 shrink-0">
              <UniLogo className="w-8 h-8" />
              <span className="font-bold text-lg hidden sm:inline">
                Unicorn StelDex
              </span>
            </Link>
            <nav className="hidden md:flex items-center gap-1">
              <NavItems />
            </nav>
          </div>

          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="rounded-full hidden md:flex"
                >
                  <MoreHorizontal className="w-5 h-5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="rounded-2xl">
                {moreLinks.map((link) => (
                  <DropdownMenuItem key={link.href} asChild>
                    <Link href={link.href} className="cursor-pointer">
                      {link.label}
                    </Link>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            {address ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button className="rounded-[16px] bg-primary hover:bg-primary/90 text-primary-foreground font-semibold text-[15px] px-4 h-10">
                    {formatAddress(address)}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56 rounded-2xl">
                  <div className="px-3 py-2">
                    <p className="text-xs text-muted-foreground">
                      Freighter · Testnet
                    </p>
                    <p className="text-sm font-mono mt-0.5 truncate">
                      {address}
                    </p>
                  </div>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={copyAddress}
                    className="gap-2 cursor-pointer"
                  >
                    <Copy className="w-4 h-4" /> Copy address
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <a
                      href={`${TESTNET_EXPLORER}${address}`}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-2 cursor-pointer"
                    >
                      <ExternalLink className="w-4 h-4" /> Explorer
                    </a>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={disconnect}
                    className="gap-2 text-destructive cursor-pointer"
                  >
                    <LogOut className="w-4 h-4" /> Disconnect
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Dialog
                open={isWalletDialogOpen}
                onOpenChange={setIsWalletDialogOpen}
              >
                <DialogTrigger asChild>
                  <Button className="rounded-[16px] bg-primary hover:bg-primary/90 text-primary-foreground font-semibold text-[15px] px-5 h-10">
                    Connect
                  </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-sm rounded-[24px]">
                  <DialogHeader>
                    <DialogTitle>Connect Freighter</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-3 pt-2">
                    <button
                      onClick={handleConnect}
                      disabled={isConnecting}
                      className="w-full flex items-center gap-3 p-4 rounded-[20px] border border-border hover:border-primary/30 hover:bg-muted/30 transition-all disabled:opacity-50"
                    >
                      <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                        <Zap className="w-5 h-5 text-primary" />
                      </div>
                      <div className="text-left flex-1">
                        <p className="font-semibold">Freighter Wallet</p>
                        <p className="text-xs text-muted-foreground">
                          Stellar Testnet
                        </p>
                      </div>
                    </button>
                    {freighterInstalled === false && (
                      <a
                        href={FREIGHTER_INSTALL_URL}
                        target="_blank"
                        rel="noreferrer"
                        className="block text-center text-xs text-primary hover:underline"
                      >
                        Install Freighter →
                      </a>
                    )}
                  </div>
                </DialogContent>
              </Dialog>
            )}

            <Sheet open={isMobileMenuOpen} onOpenChange={setIsMobileMenuOpen}>
              <SheetTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="md:hidden rounded-full"
                >
                  <Menu className="w-5 h-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="right" className="flex flex-col gap-1 pt-12">
                <NavItems onNav={() => setIsMobileMenuOpen(false)} />
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </header>

      <main className="flex-1 flex flex-col relative z-10">{children}</main>
    </div>
  );
}
