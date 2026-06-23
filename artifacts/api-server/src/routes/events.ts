/**
 * Server-Sent Events stream for real-time on-chain activity.
 * Clients connect via EventSource to receive swap, mint, and heartbeat events.
 */
import { Router, type IRouter, type Request, type Response } from "express";

const router: IRouter = Router();

const HORIZON_URL = "https://horizon-testnet.stellar.org";

type StreamEvent = {
  type: string;
  timestamp: number;
  hash?: string;
  contract?: string;
  topic?: string;
  data?: unknown;
};

function writeEvent(res: Response, event: StreamEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function fetchRecentOperations(): Promise<StreamEvent[]> {
  try {
    const res = await fetch(
      `${HORIZON_URL}/operations?order=desc&limit=5&include_failed=false`
    );
    if (!res.ok) return [];
    const body = (await res.json()) as {
      _embedded?: { records?: Array<{ type: string; transaction_hash: string; created_at: string }> };
    };
    return (body._embedded?.records ?? []).map((op) => ({
      type: "operation",
      timestamp: new Date(op.created_at).getTime(),
      hash: op.transaction_hash,
      topic: op.type,
    }));
  } catch {
    return [];
  }
}

const seenHashes = new Set<string>();
const MAX_SEEN = 200;

function dedupeEvents(events: StreamEvent[]): StreamEvent[] {
  const fresh: StreamEvent[] = [];
  for (const event of events) {
    const key = event.hash ?? `${event.type}:${event.timestamp}`;
    if (seenHashes.has(key)) continue;
    seenHashes.add(key);
    fresh.push(event);
    if (seenHashes.size > MAX_SEEN) {
      const oldest = seenHashes.values().next().value;
      if (oldest) seenHashes.delete(oldest);
    }
  }
  return fresh;
}

router.get("/stellar/events", (req: Request, res: Response): void => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  writeEvent(res, { type: "connected", timestamp: Date.now() });

  let closed = false;
  req.on("close", () => {
    closed = true;
  });

  const heartbeat = setInterval(() => {
    if (closed) return;
    writeEvent(res, { type: "heartbeat", timestamp: Date.now() });
  }, 15_000);

  const poll = setInterval(async () => {
    if (closed) return;
    const ops = dedupeEvents(await fetchRecentOperations());
    for (const op of ops) {
      writeEvent(res, op);
    }
  }, 10_000);

  // Send initial batch immediately
  fetchRecentOperations().then((ops) => {
    if (closed) return;
    for (const op of dedupeEvents(ops)) {
      writeEvent(res, op);
    }
  });

  req.on("close", () => {
    clearInterval(heartbeat);
    clearInterval(poll);
  });
});

export default router;
