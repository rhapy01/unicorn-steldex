/**
 * Freighter wallet — follows official docs:
 * https://docs.freighter.app/extension-freighter-api/connecting
 * https://docs.freighter.app/extension-freighter-api/signing
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
  isConnected,
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
  freighterInstalled: boolean | null;
  networkPassphrase: string;
  connect: () => Promise<void>;
  disconnect: () => void;
  signTx: (xdr: string) => Promise<string>;
};

const WalletContext = createContext<WalletState | null>(null);

async function freighterReady(): Promise<boolean> {
  const first = await isConnected();
  if (first.isConnected) return true;
  // Extension injects slightly after page load — one short retry only.
  await new Promise((r) => setTimeout(r, 300));
  const second = await isConnected();
  return !!second.isConnected;
}

function useWalletState(): WalletState {
  const [address, setAddress] = useState<string | null>(() =>
    typeof window !== "undefined" ? localStorage.getItem(WALLET_KEY) : null
  );
  const [isConnecting, setIsConnecting] = useState(false);
  const [freighterInstalled, setFreighterInstalled] = useState<boolean | null>(null);
  const [networkPassphrase, setNetworkPassphrase] = useState(TESTNET_PASSPHRASE);

  // Restore session if this site is already on Freighter's allow list.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const ready = await freighterReady();
        if (cancelled) return;
        setFreighterInstalled(ready);
        if (!ready) return;

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
        if (!cancelled) setFreighterInstalled(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Docs: isConnected() then requestAccess()
  const connect = useCallback(async () => {
    setIsConnecting(true);
    try {
      const ready = await freighterReady();
      setFreighterInstalled(ready);
      if (!ready) {
        throw new Error(
          "Freighter is not installed. Install from freighter.app, unlock it, set network to Testnet, then refresh this page."
        );
      }

      const access = await requestAccess();
      if (access.error) {
        throw new Error(access.error.message || "Access denied in Freighter");
      }
      if (!access.address) {
        throw new Error("No address returned from Freighter");
      }

      const network = await getNetworkDetails();
      if (network.networkPassphrase && !network.error) {
        setNetworkPassphrase(network.networkPassphrase);
      }

      setAddress(access.address);
      localStorage.setItem(WALLET_KEY, access.address);
    } finally {
      setIsConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    setAddress(null);
    localStorage.removeItem(WALLET_KEY);
  }, []);

  // Docs: signTransaction(xdr, { networkPassphrase, address })
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
