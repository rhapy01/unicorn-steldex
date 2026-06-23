import { useEffect, useState, useCallback } from "react";

export type StellarStreamEvent = {
  type: string;
  timestamp: number;
  hash?: string;
  contract?: string;
  topic?: string;
  data?: unknown;
};

type UseStellarEventsOptions = {
  enabled?: boolean;
  onEvent?: (event: StellarStreamEvent) => void;
};

/**
 * Subscribe to real-time on-chain activity via Server-Sent Events.
 * Connects to /api/stellar/events and accumulates the latest events.
 */
export function useStellarEvents({ enabled = true, onEvent }: UseStellarEventsOptions = {}) {
  const [events, setEvents] = useState<StellarStreamEvent[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearEvents = useCallback(() => setEvents([]), []);

  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") return;

    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      source = new EventSource("/api/stellar/events");

      source.onopen = () => {
        setIsConnected(true);
        setError(null);
      };

      source.onmessage = (msg) => {
        try {
          const event = JSON.parse(msg.data) as StellarStreamEvent;
          if (event.type === "heartbeat") return;
          setEvents((prev) => [event, ...prev].slice(0, 50));
          onEvent?.(event);
        } catch {
          // ignore malformed events
        }
      };

      source.onerror = () => {
        setIsConnected(false);
        setError("Event stream disconnected — reconnecting…");
        source?.close();
        if (!closed) {
          reconnectTimer = setTimeout(connect, 5000);
        }
      };
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      source?.close();
      setIsConnected(false);
    };
  }, [enabled, onEvent]);

  return { events, isConnected, error, clearEvents };
}
