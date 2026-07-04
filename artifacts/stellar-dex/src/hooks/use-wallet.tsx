/**
 * Freighter wallet integration.
 * Connect = requestAccess() — do not trust isConnected() alone; it often
 * returns false while the extension is installed (late content-script inject).
 * Freighter sets window.freighter when ready (see @stellar/freighter-api isConnected.ts).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  requestAccess,
  signTransaction,
  getNetworkDetails,
  isAllowed,
  getAddress,
} from "@stellar/freighter-api";

const WALLET_KEY = "stellar_wallet_address";

export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
export const FREIGHTER_INSTALL_URL = "https://www.freighter.app/";

type FreighterWindow = Window & { freighter?: boolean };

export type WalletState = {
  address: string | null;
  isConnecting: boolean;
  freighterInstalled: boolean | null;
  networkPassphrase: string;
  connect: () => Promise<void>;
  disconnect: () => void;
  signTx: (xdr: string) => Promise<string>;
};

const WalletContext = createContext<WalletState | null>(null);

function hasFreighterInject(): boolean {
  return typeof window !== "undefined" && !!(window as FreighterWindow).freighter;
}

/** Wait for Freighter content script (window.freighter). Soft wait only. */
async function waitForInject(maxMs = 4000): Promise<boolean> {
  if (hasFreighterInject()) return true;
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, 100));
    if (hasFreighterInject()) return true;
  }
  return hasFreighterInject();
}

function useWalletState(): WalletState {
  const [address, setAddress] = useState<string | null>(() =>
    typeof window !== "undefined" ? localStorage.getItem(WALLET_KEY) : null
  );
  const [isConnecting, setIsConnecting] = useState(false);
  const [freighterInstalled, setFreighterInstalled] = useState<boolean | null>(null);
  const [networkPassphrase, setNetworkPassphrase] = useState(TESTNET_PASSPHRASE);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      await waitForInject(2000);
      if (cancelled) return;

      const injected = hasFreighterInject();
      setFreighterInstalled(injected);

      if (!injected || !localStorage.getItem(WALLET_KEY)) return;

      try {
        const allowed = await isAllowed();
        if (cancelled || !allowed.isAllowed) return;

        const { address: addr, error } = await getAddress();
        if (cancelled || error || !addr) return;

        setAddress(addr);
        localStorage.setItem(WALLET_KEY, addr);

        const network = await getNetworkDetails();
        if (!cancelled && network.networkPassphrase && !network.error) {
          setNetworkPassphrase(network.networkPassphrase);
        }
      } catch {
        // leave cached address; user can reconnect
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const connect = useCallback(async () => {
    setIsConnecting(true);
    try {
      // Wait for content script — do NOT abort if isConnected is false.
      await waitForInject(4000);

      const access = await requestAccess();
      if (access.error) {
        throw new Error(access.error.message || "Access denied in Freighter");
      }
      if (!access.address) {
        throw new Error("Unlock Freighter, approve this site, then try Connect again.");
      }

      setFreighterInstalled(true);

      const network = await getNetworkDetails();
      if (network.networkPassphrase && !network.error) {
        setNetworkPassphrase(network.networkPassphrase);
      }

      setAddress(access.address);
      localStorage.setItem(WALLET_KEY, access.address);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // Only mention install if Freighter never injected into the page.
      if (!hasFreighterInject() && /timeout|failed to fetch|could not establish|receiving end/i.test(msg)) {
        setFreighterInstalled(false);
        throw new Error(
          "Cannot reach Freighter. Unlock the extension, refresh this page, set network to Testnet, then Connect again."
        );
      }
      throw e instanceof Error ? e : new Error(msg);
    } finally {
      setIsConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    setAddress(null);
    localStorage.removeItem(WALLET_KEY);
  }, []);

  const signTx = useCallback(
    async (xdr: string): Promise<string> => {
      if (!address) throw new Error("Connect wallet first");

      const result = await signTransaction(xdr, {
        networkPassphrase,
        address,
      });
      if (result.error) throw new Error(result.error.message || "Signing failed");
      return result.signedTxXdr;
    },
    [address, networkPassphrase]
  );

  return useMemo(
    () => ({
      address,
      isConnecting,
      freighterInstalled,
      networkPassphrase,
      connect,
      disconnect,
      signTx,
    }),
    [address, isConnecting, freighterInstalled, networkPassphrase, connect, disconnect, signTx]
  );
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const value = useWalletState();
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within WalletProvider");
  return ctx;
}
