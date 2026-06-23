import { useState, useEffect, useCallback } from "react";
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
  freighterInstalled: boolean | null;
  networkPassphrase: string;
  connect: () => Promise<void>;
  disconnect: () => void;
  signTx: (xdr: string) => Promise<string>;
};

export function useWallet(): WalletState {
  const [address, setAddress] = useState<string | null>(() =>
    typeof window !== "undefined" ? localStorage.getItem(WALLET_KEY) : null
  );
  const [isConnecting, setIsConnecting] = useState(false);
  const [freighterInstalled, setFreighterInstalled] = useState<boolean | null>(null);
  const [networkPassphrase, setNetworkPassphrase] = useState(TESTNET_PASSPHRASE);

  useEffect(() => {
    const restore = async () => {
      try {
        const result = await freighterIsConnected();
        const installed = !!result.isConnected;
        setFreighterInstalled(installed);
        if (!installed || !localStorage.getItem(WALLET_KEY)) return;

        const allowed = await isAllowed();
        if (!allowed.isAllowed) return;

        const addr = await getAddress();
        if (addr.address && !addr.error) {
          setAddress(addr.address);
          localStorage.setItem(WALLET_KEY, addr.address);
        }

        const network = await getNetworkDetails();
        if (network.networkPassphrase && !network.error) {
          setNetworkPassphrase(network.networkPassphrase);
        }
      } catch {
        setFreighterInstalled(false);
      }
    };
    restore();
  }, []);

  const connect = useCallback(async () => {
    setIsConnecting(true);
    try {
      const installed = await freighterIsConnected();
      if (!installed.isConnected) {
        throw new Error(
          "Freighter is not installed. Get it at freighter.app, set network to Testnet, then reconnect."
        );
      }

      const access = await requestAccess();
      if (access.error) throw new Error(access.error.message || "Freighter access denied");

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

  return {
    address,
    isConnecting,
    freighterInstalled,
    networkPassphrase,
    connect,
    disconnect,
    signTx,
  };
}
