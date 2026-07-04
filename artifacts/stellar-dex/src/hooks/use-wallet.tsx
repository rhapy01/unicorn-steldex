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
  isConnected as freighterIsConnected,
  requestAccess,
  signTransaction,
  getNetworkDetails,
  isAllowed,
  getAddress,
} from "@stellar/freighter-api";

const WALLET_KEY = "stellar_wallet_address";

export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
export const FREIGHTER_INSTALL_URL = "https://www.freighter.app/";

export type WalletState = {
  address: string | null;
  isConnecting: boolean;
  /** null = still probing; true/false after probe. Never blocks Connect. */
  freighterInstalled: boolean | null;
  networkPassphrase: string;
  connect: () => Promise<void>;
  disconnect: () => void;
  signTx: (xdr: string) => Promise<string>;
};

const WalletContext = createContext<WalletState | null>(null);

/** Freighter injects after page load — poll briefly before giving up. */
async function probeFreighter(attempts = 10, delayMs = 200): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await freighterIsConnected();
      if (result.isConnected) return true;
    } catch {
      // extension not ready yet
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

function isMissingExtensionError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("not installed") ||
    m.includes("not found") ||
    m.includes("could not find") ||
    m.includes("no freighter") ||
    m.includes("freighter is not") ||
    m.includes("extension")
  );
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

    const restore = async () => {
      const installed = await probeFreighter();
      if (cancelled) return;
      setFreighterInstalled(installed);

      // Keep a cached address visible even if Freighter is slow to inject;
      // connect/sign will re-validate.
      if (!localStorage.getItem(WALLET_KEY)) return;

      if (!installed) return;

      try {
        const allowed = await isAllowed();
        if (cancelled) return;
        if (!allowed.isAllowed) {
          setAddress(null);
          localStorage.removeItem(WALLET_KEY);
          return;
        }

        const addr = await getAddress();
        if (cancelled) return;
        if (addr.address && !addr.error) {
          setAddress(addr.address);
          localStorage.setItem(WALLET_KEY, addr.address);
        }

        const network = await getNetworkDetails();
        if (cancelled) return;
        if (network.networkPassphrase && !network.error) {
          setNetworkPassphrase(network.networkPassphrase);
        }
      } catch {
        // Freighter present but not ready — leave cached address; user can reconnect.
      }
    };

    void restore();
    return () => {
      cancelled = true;
    };
  }, []);

  const connect = useCallback(async () => {
    setIsConnecting(true);
    try {
      // Do not gate on isConnected() — it is often false while Freighter is installed
      // (late inject, locked wallet, first visit). requestAccess is the real check.
      const access = await requestAccess();
      if (access.error) {
        const msg = access.error.message || "Freighter access denied";
        if (isMissingExtensionError(msg)) {
          setFreighterInstalled(false);
          throw new Error(
            "Freighter not detected. Unlock Freighter, allow this site, set network to Testnet, then try again. Install: freighter.app"
          );
        }
        throw new Error(msg);
      }

      if (!access.address) {
        throw new Error("Freighter did not return an address. Unlock Freighter and try again.");
      }

      setFreighterInstalled(true);

      const network = await getNetworkDetails();
      if (network.networkPassphrase && !network.error) {
        setNetworkPassphrase(network.networkPassphrase);
      } else {
        setNetworkPassphrase(TESTNET_PASSPHRASE);
      }

      setAddress(access.address);
      localStorage.setItem(WALLET_KEY, access.address);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isMissingExtensionError(msg) || msg.includes("Failed to fetch") || msg.includes("Could not establish connection")) {
        setFreighterInstalled(false);
        throw new Error(
          "Freighter not detected. Unlock Freighter, allow this site, set network to Testnet, then try again. Install: freighter.app"
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
      if (!address) throw new Error("Wallet not connected");

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
  if (!ctx) {
    throw new Error("useWallet must be used within WalletProvider");
  }
  return ctx;
}
