# Unicorn StelDex

A production-grade decentralized exchange on **Stellar Testnet** built with real **Soroban smart contracts**: concentrated liquidity pools (Uniswap V3-style CLMM), veToken farming, on-chain limit orders, multi-hop routing, and **Freighter wallet integration**.

> **Assessor note:** Wallet integration is in [`artifacts/stellar-dex/src/hooks/use-wallet.ts`](artifacts/stellar-dex/src/hooks/use-wallet.ts) and [`artifacts/stellar-dex/src/hooks/use-stellar.ts`](artifacts/stellar-dex/src/hooks/use-stellar.ts). Soroban contract calls are in [`artifacts/api-server/src/routes/stellar.ts`](artifacts/api-server/src/routes/stellar.ts).

---

## Live Demo

| Resource | Link |
|----------|------|
| **Live App** | https://stellar-swap-dex.vercel.app |
| **GitHub Repo** | https://github.com/rhapy01/unicorn-steldex |

---

## ✅ Deployed Contracts (Stellar Testnet)

All contracts are live on **Stellar Testnet** and verifiable on [Stellar Expert](https://stellar.expert/explorer/testnet).

| Contract | Address | Explorer Link |
|----------|---------|---------------|
| **Factory** | `CCEWHLIJ4DN2C5T4HMYQQWN5J6REANDTH75P5ADETGQ5BZJG3YLISTVJ` | [View on Explorer](https://stellar.expert/explorer/testnet/contract/CCEWHLIJ4DN2C5T4HMYQQWN5J6REANDTH75P5ADETGQ5BZJG3YLISTVJ) |
| **Router** | `CAGSKATNIUPSKGRVRH7KBTU7XITHYTRFLY3AW56S4TMZMIZ3OVCPTBFD` | [View on Explorer](https://stellar.expert/explorer/testnet/contract/CAGSKATNIUPSKGRVRH7KBTU7XITHYTRFLY3AW56S4TMZMIZ3OVCPTBFD) |
| **Farm** | `CAKFQ22D3IOLNGVLIDBW5SOVH63D2YUENYSAGXPYD2YDLTP2L32CCFZD` | [View on Explorer](https://stellar.expert/explorer/testnet/contract/CAKFQ22D3IOLNGVLIDBW5SOVH63D2YUENYSAGXPYD2YDLTP2L32CCFZD) |
| **Orders** | `CASLA3FDOK7L3A2XBDWNIKUPJGOLZBDITXWCU7TGDJWOPYHQ644UDV6H` | [View on Explorer](https://stellar.expert/explorer/testnet/contract/CASLA3FDOK7L3A2XBDWNIKUPJGOLZBDITXWCU7TGDJWOPYHQ644UDV6H) |
| **XLM/pUSDC Pool** | `CD6QDXJ6HAUQ4PXYCU5FS5L5GZQ43TCNST7MR4VC5UWXM7AYZVE5GP5B` | [View on Explorer](https://stellar.expert/explorer/testnet/contract/CD6QDXJ6HAUQ4PXYCU5FS5L5GZQ43TCNST7MR4VC5UWXM7AYZVE5GP5B) |
| **XLM/cUSDC Pool** | `CDJH3ORUUPC7GFV5UDCZE4UU4ZDZAO2X73AOHP7BMXADV7ER3OLLDGXU` | [View on Explorer](https://stellar.expert/explorer/testnet/contract/CDJH3ORUUPC7GFV5UDCZE4UU4ZDZAO2X73AOHP7BMXADV7ER3OLLDGXU) |
| **EURC/XLM Pool** | `CBJOKMRM54Y2T4MHD7OECFTZR2RPPXF2NW7LZYGQBOMV5FCLKFYLFWLR` | [View on Explorer](https://stellar.expert/explorer/testnet/contract/CBJOKMRM54Y2T4MHD7OECFTZR2RPPXF2NW7LZYGQBOMV5FCLKFYLFWLR) |
| **STELLAR/XLM Pool** | `CCAQL2EQLQVGVAMPA42THBJJ3BB6PVUEUKEC2TMK3U7FUEOFI6BBPJZQ` | [View on Explorer](https://stellar.expert/explorer/testnet/contract/CCAQL2EQLQVGVAMPA42THBJJ3BB6PVUEUKEC2TMK3U7FUEOFI6BBPJZQ) |
| **XLM Token SAC** | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` | [View on Explorer](https://stellar.expert/explorer/testnet/contract/CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC) |
| **pUSDC Token** | `CBJVNOPY4KCBUK6D27DKMTRDFAMR6K6J5EFO4DS2LOGI5N7WGFYFOSB4` | [View on Explorer](https://stellar.expert/explorer/testnet/contract/CBJVNOPY4KCBUK6D27DKMTRDFAMR6K6J5EFO4DS2LOGI5N7WGFYFOSB4) |
| **STELLAR Token** | `CA2V6BTOFCL4OQOYGQQPGUO4PHUOSMH67HC363MXQKOHM2WTG4CGYND4` | [View on Explorer](https://stellar.expert/explorer/testnet/contract/CA2V6BTOFCL4OQOYGQQPGUO4PHUOSMH67HC363MXQKOHM2WTG4CGYND4) |
| **Circle cUSDC** | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` | [View on Explorer](https://stellar.expert/explorer/testnet/contract/CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA) |
| **EURC Token** | `CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ` | [View on Explorer](https://stellar.expert/explorer/testnet/contract/CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ) |

**Deployer public key:** `GC6Y34Q5VWMHL3N2GUVY7HDQUCYLEJLRNSPYV6A4BS5JNKRUVOLZZBCI`

**Deployment date:** June 11, 2026 — [verify on Stellar Expert](https://stellar.expert/explorer/testnet/account/GC6Y34Q5VWMHL3N2GUVY7HDQUCYLEJLRNSPYV6A4BS5JNKRUVOLZZBCI)

**Sample transaction hash (contract interaction):** `_Execute a swap and paste tx hash here_`

---

## ✅ Stellar Wallet Integration

### Library used: `@stellar/freighter-api`

**File:** [`artifacts/stellar-dex/src/hooks/use-wallet.ts`](artifacts/stellar-dex/src/hooks/use-wallet.ts)

```typescript
import {
  isConnected as freighterIsConnected,
  requestAccess,
  signTransaction,
  getNetworkDetails,
  isAllowed,
  getAddress,
} from "@stellar/freighter-api";
```

### Connect wallet + retrieve address

```typescript
// Request wallet permissions and retrieve Stellar public key
const access = await requestAccess();
// access.address = "GABC...XYZ" (Stellar Ed25519 public key)
setAddress(access.address);
```

### Transaction signing

```typescript
// Sign unsigned XDR with Freighter — private key never leaves the browser
const result = await signTransaction(xdr, {
  networkPassphrase: "Test SDF Network ; September 2015",
  address,
});
const signedXdr = result.signedTxXdr;
```

### Unsigned XDR pattern (security architecture)

The API builds unsigned Soroban transaction XDR. Freighter signs it client-side. The frontend submits the signed tx directly to Soroban RPC:

```
Frontend → POST /api/stellar/swap → unsigned XDR
Frontend → Freighter.signTransaction(xdr) → signed XDR  
Frontend → Soroban RPC sendTransaction(signedXdr) → tx hash
```

**Key files:**
- [`artifacts/stellar-dex/src/hooks/use-wallet.ts`](artifacts/stellar-dex/src/hooks/use-wallet.ts) — `useWallet()` hook: connect, disconnect, address, signTx
- [`artifacts/stellar-dex/src/hooks/use-stellar.ts`](artifacts/stellar-dex/src/hooks/use-stellar.ts) — `useStellarContract()`: executeSwap, addLiquidity, removeLiquidity, stakeFarm, placeLimitOrder
- [`artifacts/api-server/src/routes/stellar.ts`](artifacts/api-server/src/routes/stellar.ts) — 20+ Soroban XDR builder endpoints
- [`artifacts/stellar-dex/src/pages/swap.tsx`](artifacts/stellar-dex/src/pages/swap.tsx) — Swap UI calling the wallet

---

## ✅ Inter-Contract Communication

The Router contract calls Factory to look up pools, then calls the Pool contract to execute swaps. The Farm contract reads LP positions from Pool. The Orders contract triggers swaps through Pool:

```
Router.swap() → Factory.get_pool() → Pool.swap()
Farm.stake()  → Pool.get_position()
Orders.fill() → Pool.swap()
```

**File:** [`contracts/router/src/lib.rs`](contracts/router/src/lib.rs)

---

## ✅ Event Streaming (Real-time Updates)

Soroban contract events are polled via Horizon and streamed to the frontend via Server-Sent Events:

```
Soroban RPC events → API /api/stellar/events (SSE) → Frontend EventSource
```

**Files:**
- [`artifacts/api-server/src/routes/events.ts`](artifacts/api-server/src/routes/events.ts) — SSE endpoint
- [`artifacts/stellar-dex/src/hooks/use-stellar-events.ts`](artifacts/stellar-dex/src/hooks/use-stellar-events.ts) — EventSource hook
- [`artifacts/stellar-dex/src/pages/transactions.tsx`](artifacts/stellar-dex/src/pages/transactions.tsx) — Live Activity page

---

## Features

- **Swap** — XLM ↔ pUSDC ↔ cUSDC ↔ EURC ↔ STELLAR with slippage controls
- **Pools** — Concentrated liquidity (CLMM) with tick ranges, fee tiers, Create Pool via factory
- **Farm** — veToken model: lock LP up to 3 years for 2.5× reward boost
- **Limit Orders** — On-chain resting orders with IOC fill, expiry, keeper bot
- **Portfolio** — Live Horizon balances, LP positions, Add/Remove liquidity, tx history
- **Activity** — Real-time on-chain event feed via SSE
- **Mobile responsive** — Sheet navigation, responsive grids on all breakpoints

---

## Architecture

```
Frontend (React 19 + Vite)
  └── useWallet()          → @stellar/freighter-api (connect, address, signTx)
  └── useStellarContract() → POST /api/stellar/* (get unsigned XDR)
  └── EventSource          → GET /api/stellar/events (SSE stream)

API Server (Express 5)
  └── /api/stellar/swap           → builds Soroban swap XDR
  └── /api/stellar/add-liquidity  → builds mint XDR (multi-step)
  └── /api/stellar/stake          → builds farm stake XDR
  └── /api/stellar/limit-order    → builds or fills order XDR
  └── /api/stellar/events         → SSE: Horizon event polling

Soroban Contracts (Rust/WASM on Testnet)
  └── Factory  → CCEWHLIJ...
  └── Router   → CAGSKATN...
  └── Pool     → CD6QDXJ6... (+ 9 more pairs)
  └── Farm     → CAKFQ22D...
  └── Orders   → CASLA3FD...
```

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Smart Contracts | Rust, Soroban SDK 22, WASM |
| Wallet | `@stellar/freighter-api` — Freighter browser extension |
| Frontend | React 19, Vite 7, Tailwind CSS 4, shadcn/ui, TanStack Query |
| API | Express 5, TypeScript, Zod, OpenAPI codegen |
| CI/CD | GitHub Actions |

---

## Quick Start

```bash
git clone https://github.com/rhapy01/unicorn-steldex.git
cd unicorn-steldex
npx pnpm install
npx pnpm dev
# API → http://localhost:8080
# UI  → http://localhost:5000
```

### Run tests

```bash
npx pnpm test                                         # all tests
npx pnpm --filter @workspace/stellar-dex run test     # frontend
npx pnpm --filter @workspace/api-server run test      # API
cd contracts && cargo test --workspace                 # Soroban
```

---

## Project Structure

```
contracts/                  # Soroban WASM contracts (Rust)
  token/                    # SEP-41 token
  factory/                  # CLMM pool factory
  pool/                     # Concentrated liquidity pool
  router/                   # Multi-hop swap router
  farm/                     # veToken yield farming
  orders/                   # On-chain limit/stop orders
artifacts/
  stellar-dex/              # React 19 frontend (Vite)
    src/hooks/use-wallet.ts       ← Freighter wallet integration
    src/hooks/use-stellar.ts      ← Soroban contract calls
    src/pages/swap.tsx            ← Swap UI
    src/pages/pools.tsx           ← Liquidity UI
    src/pages/farm.tsx            ← Farming UI
    src/pages/limit-orders.tsx    ← Orders UI
    src/pages/portfolio.tsx       ← Portfolio UI
    src/pages/transactions.tsx    ← Live activity feed
  api-server/               # Express 5 API
    src/routes/stellar.ts         ← 20+ Soroban XDR builders
    src/routes/events.ts          ← SSE event stream
    src/lib/on-chain-pools.ts     ← Live pool data
    src/lib/on-chain-portfolio.ts ← Live portfolio data
lib/
  api-spec/openapi.yaml     # OpenAPI 3.1 source of truth
  api-zod/                  # Generated Zod schemas
  api-client-react/         # Generated TanStack Query hooks
scripts/                    # Deployment and test scripts
.github/workflows/ci.yml    # CI/CD pipeline
```

---

## CI/CD

GitHub Actions on every push to `main`:
- TypeScript typecheck
- Frontend vitest unit tests
- API supertest integration tests  
- Soroban `cargo test --workspace`

See [`.github/workflows/ci.yml`](.github/workflows/ci.yml)

---

## Submission Checklist

| Requirement | Status | Evidence |
|-------------|--------|---------|
| Public GitHub repo | ✅ | https://github.com/rhapy01/unicorn-steldex |
| README with documentation | ✅ | This file |
| 10+ meaningful commits | ✅ | `git log --oneline` |
| CI/CD pipeline | ✅ | `.github/workflows/ci.yml` |
| 3+ passing tests | ✅ | `npx pnpm test` — 20 tests (8 frontend + 12 API); `cargo test --workspace` — 6 Rust |
| Smart contracts (Soroban) | ✅ | `contracts/` — 6 Rust/WASM contracts |
| Inter-contract communication | ✅ | Router→Factory→Pool, Farm→Pool, Orders→Pool |
| Event streaming | ✅ | `/api/stellar/events` SSE + Activity page |
| Mobile responsive UI | ✅ | Sheet nav, responsive grids |
| Error handling & loading states | ✅ | Skeletons, toasts, error boundary |
| Stellar wallet integration | ✅ | `use-wallet.ts` — `@stellar/freighter-api` |
| Wallet address retrieval | ✅ | `getAddress()` + `requestAccess()` |
| Transaction signing | ✅ | `signTransaction(xdr, { networkPassphrase })` |
| Contract addresses | ✅ | See table above — all on testnet |
| Live demo | ✅ | https://stellar-swap-dex.vercel.app |
| Transaction hash | ⬜ | Execute swap, paste hash above |
| Screenshots | ⬜ | Add to `docs/screenshots/` |

---

## License

MIT
