import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/theme-provider";
import { Layout } from "@/components/layout";
import { ErrorBoundary } from "@/components/error-boundary";
import { WalletProvider } from "@/hooks/use-wallet";

import Swap from "@/pages/swap";
import Explore from "@/pages/explore";
import Pools from "@/pages/pools";
import Portfolio from "@/pages/portfolio";
import Transactions from "@/pages/transactions";
import Farm from "@/pages/farm";
import LimitOrders from "@/pages/limit-orders";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Swap} />
        <Route path="/explore" component={Explore} />
        <Route path="/pool" component={Pools} />
        <Route path="/farm" component={Farm} />
        <Route path="/orders" component={LimitOrders} />
        <Route path="/portfolio" component={Portfolio} />
        <Route path="/transactions" component={Transactions} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <ThemeProvider defaultTheme="light" storageKey="stellar-dex-theme">
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <ErrorBoundary>
              <WalletProvider>
                <Router />
              </WalletProvider>
            </ErrorBoundary>
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

export default App;
