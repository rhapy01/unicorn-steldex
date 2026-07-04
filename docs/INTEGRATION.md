# Unicorn StelDex — External Integration Guide

How to connect another app (chat bot, NLP agent, custom UI) to this exchange.

**Live API base:** `https://stellar-swap-dex.vercel.app/api/stellar`  
**Network:** Stellar Testnet  
**RPC:** `https://soroban-testnet.stellar.org`  
**Passphrase:** `Test SDF Network ; September 2015`

You do **not** need our private keys, our frontend, or a fork. You call our HTTP API, get unsigned XDR, have the user sign in their wallet, then submit to Soroban RPC.

---

## 1. Architecture (required)

```
Your app (chat / NLP / UI)
  │
  ├─ READ  → GET  https://stellar-swap-dex.vercel.app/api/stellar/...
  │
  └─ WRITE → POST https://stellar-swap-dex.vercel.app/api/stellar/...
                │
                ▼
         Response: { steps: [...] } or { xdr: "..." }
                │
                ▼
         User signs each XDR in Freighter (browser)
                │
                ▼
         Your app submits signed XDR to Soroban RPC
                │
                ▼
         Poll until SUCCESS → return tx hash
```

Rules:

1. Never send the user’s secret key to our API.
2. Always send `walletAddress` (public `G...` key) on write endpoints.
3. Many actions are **multi-step**. First response lists steps; you fetch each step’s XDR with `stepId`, sign, submit, wait, then continue.
4. Signing must happen in the **browser** (Freighter). Your backend can call our API and orchestrate, but it must not sign for the user unless you run a custodial wallet (out of scope here).

Reference implementation in this repo:

- Sign loop: `artifacts/stellar-dex/src/hooks/use-stellar.ts` (`buildAndSubmit`)
- Wallet: `artifacts/stellar-dex/src/hooks/use-wallet.ts`
- Routes: `artifacts/api-server/src/routes/stellar.ts`

---

## 2. Bootstrap: load contracts

```http
GET https://stellar-swap-dex.vercel.app/api/stellar/contracts
```

Example response fields:

```json
{
  "factory": "C...",
  "router": "C...",
  "farm": "C...",
  "orders": "C...",
  "tokens": {
    "XLM": "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    "pUSDC": "CBJVNOPY4KCBUK6D27DKMTRDFAMR6K6J5EFO4DS2LOGI5N7WGFYFOSB4",
    "cUSDC": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    "EURC": "CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ",
    "STELLAR": "CA2V6BTOFCL4OQOYGQQPGUO4PHUOSMH67HC363MXQKOHM2WTG4CGYND4"
  },
  "pools": [
    { "pair": "pUSDC/XLM", "contract": "CD6QDXJ6HAUQ4PXYCU5FS5L5GZQ43TCNST7MR4VC5UWXM7AYZVE5GP5B" }
  ],
  "contractsReady": true,
  "sorobanRpc": "https://soroban-testnet.stellar.org",
  "networkPassphrase": "Test SDF Network ; September 2015",
  "network": "testnet"
}
```

Cache this. Map symbols (`XLM`, `pUSDC`) → `tokens[symbol]` contract IDs. Map pairs → `pools[].contract`.

List all pools:

```http
GET https://stellar-swap-dex.vercel.app/api/stellar/pools
```

---

## 3. Amounts (decimals)

Send amounts as **integer strings in smallest units** (no floats).

| Symbol | Decimals | Human `1` → on-chain |
|--------|----------|----------------------|
| XLM | 7 | `"10000000"` |
| pUSDC | 6 | `"1000000"` |
| cUSDC | 7 | `"10000000"` |
| EURC | 7 | `"10000000"` |
| STELLAR | 7 | `"10000000"` |

```ts
function toUnits(human: string, decimals: number): string {
  const [whole, frac = ""] = human.split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole + padded).toString();
}
// toUnits("10", 7) => "100000000"   // 10 XLM
// toUnits("1.5", 6) => "1500000"    // 1.5 pUSDC
```

---

## 4. Wallet (browser)

User must use **Freighter** on **Testnet**.

```bash
npm install @stellar/freighter-api
```

```ts
import {
  isConnected,
  requestAccess,
  signTransaction,
  getNetworkDetails,
} from "@stellar/freighter-api";

const PASSPHRASE = "Test SDF Network ; September 2015";
const RPC = "https://soroban-testnet.stellar.org";

async function connectWallet(): Promise<string> {
  const installed = await isConnected();
  if (!installed.isConnected) throw new Error("Install Freighter and set network to Testnet");

  const access = await requestAccess();
  if (access.error) throw new Error(access.error.message);
  return access.address; // G...
}

async function signXdr(xdr: string, address: string): Promise<string> {
  const network = await getNetworkDetails();
  const passphrase = network.networkPassphrase || PASSPHRASE;
  const result = await signTransaction(xdr, { networkPassphrase: passphrase, address });
  if (result.error) throw new Error(result.error.message);
  return result.signedTxXdr;
}
```

---

## 5. Submit + poll (required for every write)

```ts
async function sorobanRpc(method: string, params: Record<string, unknown>) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "RPC error");
  return data.result;
}

async function pollTx(hash: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const tx = await sorobanRpc("getTransaction", { hash });
    if (tx.status === "SUCCESS") return;
    if (tx.status === "FAILED") throw new Error("Transaction failed on-chain");
  }
  throw new Error("Confirmation timeout");
}

async function submitSigned(signedXdr: string): Promise<string> {
  const send = await sorobanRpc("sendTransaction", { transaction: signedXdr });
  if (send.status === "ERROR") throw new Error(send.errorResultXdr || "Submit failed");
  if (!send.hash) throw new Error("No hash");
  await pollTx(send.hash);
  return send.hash;
}
```

---

## 6. Write flow (copy this)

Our write endpoints return either:

**A. Single XDR**

```json
{ "xdr": "AAAA..." }
```

**B. Sequential steps** (most common for swap / add LP / limit order)

```json
{
  "steps": [
    { "id": "wrap-xlm", "label": "Wrap XLM" },
    { "id": "approve", "label": "Approve" },
    { "id": "swap", "label": "Swap" }
  ],
  "sequential": true
}
```

For sequential steps, call the **same endpoint again** with `stepId` to get that step’s XDR (fresh account sequence).

```ts
const API = "https://stellar-swap-dex.vercel.app/api/stellar";

async function buildAndSubmit(
  endpoint: string,
  body: Record<string, unknown>,
  walletAddress: string,
  signTx: (xdr: string) => Promise<string>,
): Promise<string> {
  const res = await fetch(`${API}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, walletAddress }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  const data = await res.json();

  const steps = Array.isArray(data.steps)
    ? data.steps
    : data.xdr
      ? [{ id: "tx", xdr: data.xdr }]
      : [];

  if (steps.length === 0) throw new Error("No transaction steps returned");

  let lastHash = "";
  for (const step of steps) {
    let xdr = step.xdr as string | undefined;

    if (!xdr && data.sequential && step.id) {
      const stepRes = await fetch(`${API}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, walletAddress, stepId: step.id }),
      });
      if (!stepRes.ok) {
        const err = await stepRes.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${stepRes.status}`);
      }
      const stepData = await stepRes.json();
      xdr = stepData.xdr;
    }

    if (!xdr) throw new Error(`No XDR for step ${step.id}`);

    const signed = await signTx(xdr);
    lastHash = await submitSigned(signed);
  }
  return lastHash;
}
```

Always show the user what will happen and get confirmation **before** calling `buildAndSubmit`.

---

## 7. Read endpoints (for NLP context)

Use these to answer “what do I have?” before acting.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/contracts` | Tokens, pools, farm, orders addresses |
| `GET` | `/pools` | All pools |
| `GET` | `/pool-state?contract=C...` | Pool price / liquidity |
| `GET` | `/farm-pools?wallet=G...` | Farm pools + user’s LP / stake |
| `GET` | `/farm-positions?wallet=G...` | User’s staked positions |
| `GET` | `/farm-stats?wallet=G...` | Farm overview |
| `GET` | `/orders?wallet=G...` | User’s open limit orders |
| `GET` | `/order-book?pool=C...&from=XLM&to=pUSDC` | Order book for a pair |
| `POST` | `/swap/quote` | On-chain swap quote |

### Swap quote

```http
POST /api/stellar/swap/quote
Content-Type: application/json

{
  "fromTokenContract": "CDLZFC3S...",
  "toTokenContract": "CBJVNOPY...",
  "amountIn": "10000000",
  "slippageBps": 50
}
```

### Farm positions (for “remove / unstake”)

```http
GET /api/stellar/farm-positions?wallet=G...
```

Each position includes `poolContract`, `pair`, `tickLower`, `tickUpper`, `stake.liquidity`, etc.

### Farm pools (LP available to stake / remove)

```http
GET /api/stellar/farm-pools?wallet=G...
```

Use `lpLiquidity` / `availableToStake` / `stakedLiquidity` to decide amounts.

---

## 8. Write endpoints (actions)

Base path: `https://stellar-swap-dex.vercel.app/api/stellar`

Every body must include `walletAddress`.

### 8.1 Swap

```http
POST /swap
```

```json
{
  "walletAddress": "G...",
  "fromTokenContract": "CDLZFC3S...",
  "toTokenContract": "CBJVNOPY...",
  "amountIn": "10000000",
  "slippageBps": 50
}
```

Optional: `minAmountOut` (string). Prefer omitting it and letting the API compute from simulation + `slippageBps`.

```ts
await buildAndSubmit("swap", {
  fromTokenContract: tokens.XLM,
  toTokenContract: tokens.pUSDC,
  amountIn: toUnits("10", 7),
  slippageBps: 50,
}, wallet, signTx);
```

### 8.2 Add liquidity

```http
POST /add-liquidity
```

```json
{
  "walletAddress": "G...",
  "poolContract": "CD6QDXJ6...",
  "token0Contract": "CBJVNOPY...",
  "token1Contract": "CDLZFC3S...",
  "tickLower": -443580,
  "tickUpper": 443580,
  "amount0Desired": "1000000",
  "amount1Desired": "10000000"
}
```

Full-range ticks for our pools: **`tickLower: -443580`**, **`tickUpper: 443580`**.

Token order must match the pool’s `token0` / `token1` (API also canonicalizes by address). Safest: pass both contracts and the pool address from `/contracts` or `/pools`.

### 8.3 Remove liquidity

```http
POST /remove-liquidity
```

```json
{
  "walletAddress": "G...",
  "poolContract": "CD6QDXJ6...",
  "tickLower": -443580,
  "tickUpper": 443580,
  "liquidity": "123456",
  "amount0Min": "0",
  "amount1Min": "0"
}
```

`liquidity` is the LP position size (string integer), **not** a human token amount. Get it from farm-pools / position reads (`lpLiquidity`).

Returns `{ "xdr": "..." }` (single step).

```ts
await buildAndSubmit("remove-liquidity", {
  poolContract,
  tickLower: -443580,
  tickUpper: 443580,
  liquidity: position.lpLiquidity,
  amount0Min: "0",
  amount1Min: "0",
}, wallet, signTx);
```

### 8.4 Farm stake

```http
POST /stake
```

```json
{
  "walletAddress": "G...",
  "poolContract": "CD6QDXJ6...",
  "tickLower": -443580,
  "tickUpper": 443580,
  "stakeMax": true,
  "lockWeeks": 52,
  "autoCompound": false
}
```

- `lockWeeks`: 1–156
- `stakeMax: true` stakes full LP for that tick range
- Or pass `liquidity` as a string

### 8.5 Farm claim

```http
POST /claim
```

```json
{
  "walletAddress": "G...",
  "poolContract": "CD6QDXJ6...",
  "tickLower": -443580,
  "tickUpper": 443580
}
```

### 8.6 Farm unstake

```http
POST /unstake
```

```json
{
  "walletAddress": "G...",
  "poolContract": "CD6QDXJ6...",
  "tickLower": -443580,
  "tickUpper": 443580,
  "unstakeMax": true
}
```

Or pass `liquidity` string.

### 8.7 Limit order

```http
POST /limit-order
```

```json
{
  "walletAddress": "G...",
  "fromContract": "CDLZFC3S...",
  "toContract": "CBJVNOPY...",
  "amount": "10000000",
  "limitPrice": "100000",
  "orderType": "Limit",
  "expiryHours": 72
}
```

- `amount`: input token units
- `limitPrice`: price in **output token units per 1 input token**, using **output token decimals** (same encoding as amounts)
- `orderType`: `"Limit"` | `"Stop-Loss"` | `"Take-Profit"`
- If market already meets limit → executes as swap (IOC)
- Else → resting on-chain order (`resting: true` in response)

Cancel:

```http
POST /cancel-order
```

```json
{
  "walletAddress": "G...",
  "orderId": "1"
}
```

`orderId` is a string of the on-chain u64 id from `GET /orders?wallet=G...`.

---

## 9. Chat / NLP mapping

Your NLP only needs to emit structured intents. Your adapter maps them to the calls above.

| User says | Intent | Steps |
|-----------|--------|--------|
| “swap 10 XLM to pUSDC” | `swap` | resolve contracts → `POST /swap` |
| “add liquidity on XLM/pUSDC” | `add_liquidity` | resolve pool → `POST /add-liquidity` |
| “remove my liquidity on XLM/pUSDC” | `remove_liquidity` | `GET /farm-pools?wallet=` → find `lpLiquidity` → confirm → `POST /remove-liquidity` |
| “stake my LP for 52 weeks” | `stake` | find pool + LP → `POST /stake` |
| “claim farm rewards” | `claim` | `GET /farm-positions` → `POST /claim` per position |
| “unstake from farm” | `unstake` | `POST /unstake` |
| “place limit order…” | `limit_order` | `POST /limit-order` |
| “what do I have?” | `read` | `GET /farm-pools`, `/farm-positions`, `/orders` only |

### Recommended chat flow for any write

1. Connect wallet → `walletAddress`
2. Parse intent
3. **Read** positions / balances from our GET endpoints
4. Reply with a confirmation summary (pair, amount, action)
5. On user “yes” → `buildAndSubmit(...)`
6. Return tx hash + explorer link:

`https://stellar.expert/explorer/testnet/tx/<hash>`

If the user has no position, say so — do not call write endpoints.

---

## 10. End-to-end example: remove liquidity

```ts
const API = "https://stellar-swap-dex.vercel.app/api/stellar";
const FULL_RANGE = { tickLower: -443580, tickUpper: 443580 };

async function removeLiquidityForPair(
  wallet: string,
  pairHint: string, // e.g. "XLM/pUSDC" or "pUSDC/XLM"
  signTx: (xdr: string) => Promise<string>,
) {
  // 1. Find pool + LP
  const poolsRes = await fetch(`${API}/farm-pools?wallet=${encodeURIComponent(wallet)}`);
  if (!poolsRes.ok) throw new Error(await poolsRes.text());
  const pools = await poolsRes.json();

  const row = pools.find((p: { pair: string; lpLiquidity?: string }) =>
    p.pair.replace("/", "").toLowerCase().includes(
      pairHint.replace("/", "").toLowerCase().replace("xlm", "xlm")
    ) || p.pair.includes("pUSDC") && pairHint.toUpperCase().includes("PUSDC")
  );

  // Prefer exact match on symbols:
  const match = pools.find((p: { pair: string }) => {
    const a = p.pair.toUpperCase().split("/");
    const b = pairHint.toUpperCase().replace("USDC", "PUSDC").split(/[\/\s]+/);
    return a.includes(b[0]) && a.includes(b[1] || b[0]);
  }) ?? pools.find((p: { pair: string }) =>
    p.pair.toUpperCase().includes("PUSDC") && p.pair.toUpperCase().includes("XLM")
  );

  if (!match?.lpLiquidity || match.lpLiquidity === "0") {
    throw new Error("No LP position found for that pair");
  }

  // 2. Confirm in your UI/chat, then:
  return buildAndSubmit("remove-liquidity", {
    poolContract: match.poolContract,
    ...FULL_RANGE,
    liquidity: match.lpLiquidity,
    amount0Min: "0",
    amount1Min: "0",
  }, wallet, signTx);
}
```

---

## 11. Errors

Responses use JSON `{ "error": "message" }` with HTTP status:

| Status | Meaning |
|--------|---------|
| `400` | Missing / invalid params |
| `422` | Business rule (insufficient balance, bad quote, etc.) |
| `500` | Server / RPC failure |
| `503` | Contracts not configured |

Surface `error` to the user. Do not retry blindly on `422`.

---

## 12. CORS / hosting

Browser apps on **another origin** may hit CORS limits.

Options:

1. **Proxy through your backend:** browser → your server → our API. Your server only forwards JSON; signing still happens in the browser.
2. **Ask us to allow your origin** on the API (if you need direct browser calls).

Server-to-server reads (`GET`) work from any backend with no wallet.

Writes still need the user’s signature in the client.

---

## 13. Checklist for integrators

- [ ] Call `GET /contracts` and cache tokens + pools
- [ ] Connect Freighter on **Testnet**
- [ ] Convert human amounts with correct decimals
- [ ] Implement `buildAndSubmit` (sequential `stepId` loop)
- [ ] Implement RPC submit + poll
- [ ] For remove/unstake/claim: **read positions first**
- [ ] Confirm with user before signing
- [ ] Show tx hash / Stellar Expert link on success
- [ ] Never send secret keys to our API

---

## 14. Quick reference

| Action | Method | Path |
|--------|--------|------|
| Contracts | GET | `/api/stellar/contracts` |
| Pools | GET | `/api/stellar/pools` |
| Pool state | GET | `/api/stellar/pool-state?contract=` |
| Swap quote | POST | `/api/stellar/swap/quote` |
| Swap | POST | `/api/stellar/swap` |
| Add LP | POST | `/api/stellar/add-liquidity` |
| Remove LP | POST | `/api/stellar/remove-liquidity` |
| Stake | POST | `/api/stellar/stake` |
| Claim | POST | `/api/stellar/claim` |
| Unstake | POST | `/api/stellar/unstake` |
| Limit order | POST | `/api/stellar/limit-order` |
| Cancel order | POST | `/api/stellar/cancel-order` |
| Orders | GET | `/api/stellar/orders?wallet=` |
| Order book | GET | `/api/stellar/order-book?pool=&from=&to=` |
| Farm pools | GET | `/api/stellar/farm-pools?wallet=` |
| Farm positions | GET | `/api/stellar/farm-positions?wallet=` |

**Live app:** https://stellar-swap-dex.vercel.app  
**Repo:** https://github.com/rhapy01/unicorn-steldex  
**Source of truth for routes:** `artifacts/api-server/src/routes/stellar.ts`
