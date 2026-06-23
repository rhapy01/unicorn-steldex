# Submission Checklist Guide

Use this guide to complete every required item for your StellarSwap DEX submission.

## Required Items

### 1. Public GitHub repository

Push this project to a public GitHub repo. The codebase is ready; you only need to publish it.

### 2. README with complete documentation

✅ See [README.md](../README.md) — architecture, quick start, contracts, CI, and feature list.

### 3. Minimum 10+ meaningful commits

Break your work into focused commits (contracts, API, frontend, tests, CI, docs). Aim for descriptive messages like `feat(contracts): add factory pool registry tests`.

### 4. Live demo link

**Vercel + Railway/Render** (recommended):

1. Deploy `artifacts/stellar-dex` to Vercel
2. Deploy `artifacts/api-server` to Railway or Render with `DATABASE_URL` and contract env vars
3. Point the frontend API proxy / `API_URL` at the deployed API host

Paste the live URL into README under **Live Demo**.

### 5. Contract deployment address

```bash
# Build WASM
./contracts/build.sh

# Deploy to Stellar Testnet (fund key at https://laboratory.stellar.org)
DEPLOYER_SECRET_KEY=S... pnpm --filter @workspace/scripts run deploy
```

Copy addresses from `.env.contracts` into:

- API server environment variables
- README **Deployed Contracts** table

### 6. Transaction hash for contract interaction

1. Set contract env vars on the API server
2. Connect Freighter to Testnet
3. Execute a swap or farm stake from the UI
4. Copy the tx hash from the toast or [Stellar Expert](https://stellar.expert/explorer/testnet)
5. Paste into README

### 7. Screenshots

Capture and save to `docs/screenshots/`:

| File | How to capture |
|------|----------------|
| `mobile-ui.png` | Chrome DevTools → 375×812 → Swap page |
| `ci-pipeline.png` | GitHub → Actions → latest green CI run |
| `test-output.png` | Terminal after `pnpm test` |

### 8. Test output (3+ passing tests)

```bash
pnpm test
```

Current suite includes:

- 7 frontend format tests
- 9+ API tests (health, stellar routes, SSE)
- 6+ Soroban contract tests (token + factory)

### 9. Demo video (1–2 minutes)

Record a Loom or YouTube walkthrough covering:

1. Connect Freighter wallet
2. Swap tokens (or demo mode)
3. View pools / farm
4. Show Activity page live events
5. Mention Soroban contracts + CI

Add the link to README **Live Demo** table.

## Feature Coverage Map

| Requirement | Where to demonstrate |
|-------------|---------------------|
| Smart contracts | `contracts/` — 5 Soroban WASM contracts |
| Inter-contract communication | Router → Factory → Pool; Farm → Token |
| Event streaming | `/api/stellar/events` + Activity page |
| CI/CD | `.github/workflows/ci.yml` |
| Deployment workflow | `scripts/src/deploy-contracts.ts` |
| Mobile responsive UI | Layout sheet nav, responsive grids |
| Error/loading states | Skeletons, toasts, demo banner, error boundary |
| Tests | `pnpm test` + `cargo test --workspace` |
| Production architecture | OpenAPI, unsigned XDR, monorepo, demo fallback |
| Documentation | README + this guide |

## Quick Verification Commands

```bash
pnpm install
pnpm run typecheck
pnpm test
cd contracts && cargo test --workspace
```

All should pass before submitting.
