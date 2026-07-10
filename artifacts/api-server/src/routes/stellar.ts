/**
 * /api/stellar/* — On-chain transaction builders
 *
 * The frontend calls these to get unsigned XDR, then signs with Freighter
 * and submits directly to the Soroban RPC. This keeps private keys
 * exclusively in the user's wallet.
 */
import { Router, type IRouter, type Response } from "express";
import type { xdr } from "@stellar/stellar-sdk";
import { getContractConfig, requireContracts } from "../lib/contract-config.js";
import { addressScVal, feeTierScVal, scMap } from "../lib/soroban-scval.js";
import { sendStellarError, toI128String } from "../lib/stellar-errors.js";
import { canonicalizeTokenPair } from "../lib/token-order.js";
import { computeLiquidity, tickToSqrtQ32 } from "../lib/clmm-math.js";
import { simulateContractBalance } from "../lib/soroban-balance.js";
import { mintTestUsdc } from "../lib/test-faucet.js";
import { OFFICIAL_TESTNET_TOKENS } from "../lib/stellar-tokens.js";
import { assertValidTickRange, fullRangeTicks } from "../lib/pool-ticks.js";
import {
  applySlippage,
  buildPoolSwapOperation,
  parseAmountIn,
  quotePoolSwapOutput,
  quoteRouteSwapOutput,
} from "../lib/swap-sim.js";
import { listFactoryPools, resolvePoolForTokens } from "../lib/pool-registry.js";
import { decimalsForContract } from "../lib/token-decimals.js";
import { findSwapRoute, routeSymbols } from "../lib/swap-route.js";
import {
  getOnChainFarmOverview,
  getOnChainFarmPositions,
  listOnChainFarmPools,
  readFarmStake,
} from "../lib/on-chain-farm.js";
import {
  buildOrderBook,
  displayPriceToPoolSqrt,
  expiryLedgerFromHours,
  listWalletOrders,
  orderTypeToCode,
} from "../lib/on-chain-orders.js";
import { runOrderKeeperOnce } from "../lib/order-keeper.js";

const SIM_SOURCE = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";

type LiquidityFundingCtx = {
  StellarSdk: StellarSdk;
  server: ReturnType<typeof rpcServer>;
  config: ReturnType<typeof requireContracts>;
  walletAddress: string;
  deployerSecret?: string;
  faucetTx: string[];
};

/** Ensure wallet can cover `need` units; mint test tokens or return XLM wrap shortfall. */
async function ensureLiquidityTokenBalance(
  ctx: LiquidityFundingCtx,
  tokenContract: string,
  need: bigint,
): Promise<bigint> {
  const { StellarSdk, server, config, walletAddress, deployerSecret, faucetTx } = ctx;
  const bal = await simulateContractBalance(StellarSdk, server, tokenContract, walletAddress);
  if (bal >= need) return 0n;

  const shortfall = need - bal;
  const xlm = config.tokens.XLM;
  const pUsdc = config.poolUsdc || config.tokens.pUSDC;
  const stellar = config.tokens.STELLAR;

  if (tokenContract === xlm) {
    return shortfall;
  }

  const isCircleUsdc =
    tokenContract === config.circleUsdc ||
    tokenContract === OFFICIAL_TESTNET_TOKENS.USDC.sacContract;
  const isCircleEurc =
    tokenContract === config.circleEurc ||
    tokenContract === OFFICIAL_TESTNET_TOKENS.EURC.sacContract;

  if (isCircleUsdc) {
    throw new Error(
      `Insufficient cUSDC (have ${bal}, need ${need}). Enable the USDC trustline, then get test USDC from https://faucet.circle.com/ (Stellar Testnet).`,
    );
  }
  if (isCircleEurc) {
    throw new Error(
      `Insufficient EURC (have ${bal}, need ${need}). Enable the EURC trustline, then get test EURC from https://faucet.circle.com/ (Stellar Testnet).`,
    );
  }

  const mintable = tokenContract === pUsdc || tokenContract === stellar;
  if (mintable) {
    if (!deployerSecret) {
      const label = tokenContract === pUsdc ? "pUSDC" : "STELLAR";
      throw new Error(
        `Insufficient ${label} (have ${bal}, need ${need}). Set DEPLOYER_SECRET_KEY in .env or POST /api/stellar/mint-test-tokens.`,
      );
    }
    const mintHash = await mintTestUsdc(
      StellarSdk,
      deployerSecret,
      tokenContract,
      walletAddress,
      shortfall + 1_000_000n,
    );
    faucetTx.push(mintHash);
    return 0n;
  }

  throw new Error(`Insufficient token balance (have ${bal}, need ${need}).`);
}

async function simulatePoolSqrtPrice(
  StellarSdk: StellarSdk,
  server: ReturnType<typeof rpcServer>,
  poolContract: string,
): Promise<bigint> {
  const contract = new StellarSdk.Contract(poolContract);
  const source = await server.getAccount(SIM_SOURCE);
  const tx = new StellarSdk.TransactionBuilder(source, {
    fee: "1000000",
    networkPassphrase: TESTNET_PASSPHRASE,
  })
    .addOperation(contract.call("sqrt_price"))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) {
    throw new Error(`sqrt_price simulation failed: ${JSON.stringify(sim)}`);
  }
  const val = sim.result?.retval;
  if (!val) throw new Error("sqrt_price returned no value");
  return StellarSdk.scValToBigInt(val);
}

const router: IRouter = Router();

const SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

// Lazy-load stellar-sdk (large package)
async function getStellarSdk() {
  return await import("@stellar/stellar-sdk");
}

type StellarSdk = Awaited<ReturnType<typeof getStellarSdk>>;

function rpcServer(StellarSdk: StellarSdk) {
  return new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
}

function feeTierMedium(StellarSdk: StellarSdk) {
  return feeTierScVal(StellarSdk, "Medium");
}

type SwapBuildParams = {
  walletAddress: string;
  fromTokenContract: string;
  toTokenContract: string;
  amountIn: string;
  minAmountOut?: string;
  slippageBps?: number;
  stepId?: string;
};

/** Build multi-step swap XDR (wrap → approve/swap per hop). Shared by /swap and fillable /limit-order. */
async function handleSwapRequest(res: Response, params: SwapBuildParams): Promise<void> {
  const {
    walletAddress,
    fromTokenContract,
    toTokenContract,
    amountIn,
    minAmountOut,
    slippageBps = 50,
    stepId,
  } = params;

  const config = requireContracts();
  const StellarSdk = await getStellarSdk();
  if (!StellarSdk.StrKey.isValidEd25519PublicKey(walletAddress)) {
    res.status(400).json({ error: "Invalid wallet address" });
    return;
  }
  if (!StellarSdk.StrKey.isValidContract(fromTokenContract) || !StellarSdk.StrKey.isValidContract(toTokenContract)) {
    res.status(400).json({ error: "Invalid token contract address" });
    return;
  }

  const server = rpcServer(StellarSdk);
  const pools = await listFactoryPools(StellarSdk, server, config);
  const route = findSwapRoute(fromTokenContract, toTokenContract, pools);
  if (!route) {
    res.status(422).json({
      error:
        "No on-chain route for this pair (direct or multi-hop). Seed pools: pnpm --filter @workspace/scripts run setup-pools",
    });
    return;
  }

  const amountInBn = parseAmountIn(amountIn);
  const xlmContract = config.tokens.XLM;
  const pUsdcContract = config.poolUsdc || config.tokens.pUSDC;
  const stellarContract = config.tokens.STELLAR;
  const routeLabels = routeSymbols(route.path, config);

  const { amountOut: quotedOut } = await quoteRouteSwapOutput(
    StellarSdk,
    server,
    route.hops.map((h) => ({ poolAddress: h.pool.address, tokenIn: h.tokenIn })),
    amountInBn,
  );

  let minOutBn =
    minAmountOut != null && String(minAmountOut).length > 0
      ? parseAmountIn(String(minAmountOut))
      : 0n;
  if (minOutBn === 0n) {
    minOutBn = applySlippage(quotedOut, Number(slippageBps) || 50);
  }

  const fromBal = await simulateContractBalance(StellarSdk, server, fromTokenContract, walletAddress);
  const deployerSecret = process.env.DEPLOYER_SECRET_KEY;
  const faucetTx: string[] = [];

  if (fromBal < amountInBn) {
    const mintable = fromTokenContract === pUsdcContract || fromTokenContract === stellarContract;
    if (mintable && deployerSecret) {
      const mintHash = await mintTestUsdc(
        StellarSdk,
        deployerSecret,
        fromTokenContract,
        walletAddress,
        amountInBn - fromBal + 1_000_000n,
      );
      faucetTx.push(mintHash);
    } else if (fromTokenContract !== xlmContract) {
      res.status(422).json({
        error: `Insufficient balance (have ${fromBal}, need ${amountInBn}). For cUSDC/EURC enable trustlines and use https://faucet.circle.com/`,
      });
      return;
    }
  }

  const wrapAmount =
    fromTokenContract === xlmContract && fromBal < amountInBn ? amountInBn - fromBal : 0n;

  const maxApprove = BigInt("9223372036854775807");
  const walletSc = new StellarSdk.Address(walletAddress);
  const SOROBAN_FEE = "100000";

  async function singleOpXdr(operation: xdr.Operation): Promise<string> {
    const account = await server.getAccount(walletAddress);
    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: SOROBAN_FEE,
      networkPassphrase: TESTNET_PASSPHRASE,
    })
      .addOperation(operation)
      .setTimeout(300)
      .build();
    const prepared = await server.prepareTransaction(tx);
    return prepared.toXDR();
  }

  const stepPlan: Array<{ id: string; label: string }> = [];
  if (wrapAmount > 0n) {
    stepPlan.push({ id: "wrap-xlm", label: "Wrap XLM for swap" });
  }
  for (let i = 0; i < route.hops.length; i++) {
    const hopSymIn = routeLabels[i] ?? `T${i}`;
    const hopSymOut = routeLabels[i + 1] ?? `T${i + 1}`;
    stepPlan.push({
      id: `approve-${i}`,
      label:
        route.hops.length === 1
          ? "Approve pool"
          : `Approve hop ${i + 1} (${hopSymIn}→${hopSymOut})`,
    });
    stepPlan.push({
      id: `swap-${i}`,
      label:
        route.hops.length === 1
          ? "Execute swap"
          : `Swap hop ${i + 1} (${hopSymIn}→${hopSymOut})`,
    });
  }

  if (stepId) {
    const step = stepPlan.find((s) => s.id === stepId);
    if (!step) {
      res.status(400).json({ error: `Unknown stepId "${stepId}"` });
      return;
    }

    let operation: xdr.Operation;
    if (stepId === "wrap-xlm") {
      const fromTokenC = new StellarSdk.Contract(fromTokenContract);
      const balNow = await simulateContractBalance(StellarSdk, server, fromTokenContract, walletAddress);
      const wrapNow =
        fromTokenContract === xlmContract && balNow < amountInBn ? amountInBn - balNow : 0n;
      if (wrapNow <= 0n) {
        res.status(400).json({ error: "Wrap step not needed" });
        return;
      }
      operation = fromTokenC.call(
        "transfer",
        walletSc.toScVal(),
        walletSc.toScVal(),
        StellarSdk.nativeToScVal(wrapNow, { type: "i128" }),
      );
    } else if (stepId.startsWith("approve-")) {
      const hopIndex = Number(stepId.slice("approve-".length));
      const hop = route.hops[hopIndex];
      if (!hop) {
        res.status(400).json({ error: `Invalid hop ${hopIndex}` });
        return;
      }
      const tokenC = new StellarSdk.Contract(hop.tokenIn);
      const poolSc = new StellarSdk.Address(hop.pool.address);
      const latestNow = await server.getLatestLedger();
      operation = tokenC.call(
        "approve",
        walletSc.toScVal(),
        poolSc.toScVal(),
        StellarSdk.nativeToScVal(maxApprove, { type: "i128" }),
        StellarSdk.nativeToScVal(latestNow.sequence + 100_000, { type: "u32" }),
      );
    } else if (stepId.startsWith("swap-")) {
      const hopIndex = Number(stepId.slice("swap-".length));
      const hop = route.hops[hopIndex];
      if (!hop) {
        res.status(400).json({ error: `Invalid hop ${hopIndex}` });
        return;
      }
      let hopAmountIn = amountInBn;
      if (hopIndex > 0) {
        // After prior hops, spend the intermediate token balance (minus dust).
        const bal = await simulateContractBalance(StellarSdk, server, hop.tokenIn, walletAddress);
        if (bal <= 0n) {
          res.status(422).json({
            error: `No intermediate balance for hop ${hopIndex + 1}. Prior hop may have failed.`,
          });
          return;
        }
        hopAmountIn = bal;
      }
      operation = await buildPoolSwapOperation(
        StellarSdk,
        server,
        hop.pool.address,
        walletAddress,
        hop.tokenIn,
        hopAmountIn,
      );
    } else {
      res.status(400).json({ error: `Unknown stepId "${stepId}"` });
      return;
    }

    res.json({
      stepId,
      label: step.label,
      xdr: await singleOpXdr(operation),
    });
    return;
  }

  res.json({
    steps: stepPlan,
    sequential: true,
    minAmountOut: minOutBn.toString(),
    route: routeLabels,
    hops: route.hops.length,
    faucetTx: faucetTx.length > 0 ? faucetTx : undefined,
  });
}

// ---------------------------------------------------------------------------
// GET /api/stellar/contracts — return deployed contract addresses
// ---------------------------------------------------------------------------
router.get("/stellar/contracts", async (_req, res): Promise<void> => {
  const config = getContractConfig();
  let pools: Array<{ pair: string; contract: string }> = [];
  try {
    const StellarSdk = await getStellarSdk();
    const server = rpcServer(StellarSdk);
    const onChain = await listFactoryPools(StellarSdk, server, config);
    pools = onChain.map((p) => ({ pair: p.pair, contract: p.address }));
  } catch {
    if (config.pool) {
      pools.push({ pair: "pUSDC/XLM", contract: config.pool });
    }
  }

  res.json({
    factory: config.factory || null,
    router: config.router || null,
    farm: config.farm || null,
    orders: config.orders || null,
    pool: config.pool || null,
    tokens: config.tokens,
    poolUsdc: config.poolUsdc || null,
    circle: {
      usdc: config.circleUsdc || null,
      eurc: config.circleEurc || null,
    },
    pools,
    contractsReady: config.contractsReady,
    sorobanRpc: SOROBAN_RPC_URL,
    networkPassphrase: TESTNET_PASSPHRASE,
    network: "testnet",
  });
});

// ---------------------------------------------------------------------------
// GET /api/stellar/pools — all factory pools (on-chain)
// ---------------------------------------------------------------------------
router.get("/stellar/pools", async (_req, res): Promise<void> => {
  try {
    const config = requireContracts();
    const StellarSdk = await getStellarSdk();
    const server = rpcServer(StellarSdk);
    const pools = await listFactoryPools(StellarSdk, server, config);
    res.json({ pools });
  } catch (e: unknown) {
    res.status(503).json({ error: String(e) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/stellar/pool-state?contract=C... — on-chain pool state
// ---------------------------------------------------------------------------
router.get("/stellar/pool-state", async (req, res): Promise<void> => {
  const { contract } = req.query;
  if (!contract || typeof contract !== "string") {
    res.status(400).json({ error: "contract required" });
    return;
  }

  try {
    requireContracts();
  } catch (e: unknown) {
    res.status(503).json({ error: String(e) });
    return;
  }

  try {
    const StellarSdk = await getStellarSdk();
    const server = rpcServer(StellarSdk);
    const contractAddr = new StellarSdk.Contract(contract);

    const tx = new StellarSdk.TransactionBuilder(
      await server.getAccount(SIM_SOURCE),
      { fee: "1000000", networkPassphrase: TESTNET_PASSPHRASE }
    )
      .addOperation(contractAddr.call("get_state"))
      .setTimeout(30)
      .build();

    const simResult = await server.simulateTransaction(tx);
    res.json({ result: simResult });
  } catch (e: unknown) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/stellar/swap/quote — on-chain swap quote (simulation)
// ---------------------------------------------------------------------------
router.post("/stellar/swap/quote", async (req, res): Promise<void> => {
  const { walletAddress, fromTokenContract, toTokenContract, amountIn, slippageBps = 50 } =
    req.body;

  if (!walletAddress || !fromTokenContract || !toTokenContract || !amountIn) {
    res.status(400).json({
      error: "walletAddress, fromTokenContract, toTokenContract, and amountIn required",
    });
    return;
  }

  let config;
  try {
    config = requireContracts();
  } catch (e: unknown) {
    res.status(503).json({ error: String(e) });
    return;
  }

  try {
    const StellarSdk = await getStellarSdk();
    const server = rpcServer(StellarSdk);
    const pools = await listFactoryPools(StellarSdk, server, config);
    const route = findSwapRoute(fromTokenContract, toTokenContract, pools);

    if (!route) {
      res.status(422).json({
        error:
          "No on-chain route for this pair (direct or multi-hop). Seed pools: pnpm --filter @workspace/scripts run setup-pools",
      });
      return;
    }

    const amountInBn = parseAmountIn(amountIn);
    if (amountInBn <= 0n) {
      res.status(400).json({ error: "amountIn must be positive" });
      return;
    }

    const { amountOut } = await quoteRouteSwapOutput(
      StellarSdk,
      server,
      route.hops.map((h) => ({ poolAddress: h.pool.address, tokenIn: h.tokenIn })),
      amountInBn,
    );

    const minOut = applySlippage(amountOut, Number(slippageBps) || 50);
    const fromDecimals = decimalsForContract(fromTokenContract, config);
    const toDecimals = decimalsForContract(toTokenContract, config);
    const outHuman = Number(amountOut) / 10 ** toDecimals;
    const minHuman = Number(minOut) / 10 ** toDecimals;
    const inHuman = Number(amountInBn) / 10 ** fromDecimals;
    const routeLabels = routeSymbols(route.path, config);

    res.json({
      onChain: true,
      inputAmount: inHuman,
      outputAmount: outHuman,
      minimumReceived: minHuman,
      executionPrice: inHuman > 0 ? outHuman / inHuman : 0,
      priceImpact: 0,
      fee: inHuman * 0.003 * route.hops.length,
      route: routeLabels,
      hops: route.hops.length,
      amountOutRaw: amountOut.toString(),
      minAmountOutRaw: minOut.toString(),
      slippageBps: Number(slippageBps) || 50,
    });
  } catch (e: unknown) {
    sendStellarError(res, e, { wallet: walletAddress, operation: "quote" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/stellar/swap — build swap XDR (multi-step for Freighter)
// ---------------------------------------------------------------------------
router.post("/stellar/swap", async (req, res): Promise<void> => {
  const {
    walletAddress,
    amountIn,
    minAmountOut,
    fromTokenContract,
    toTokenContract,
    slippageBps = 50,
    stepId,
  } = req.body;

  if (!walletAddress) {
    res.status(400).json({ error: "walletAddress required" });
    return;
  }

  try {
    requireContracts();
  } catch (e: unknown) {
    res.status(503).json({ error: String(e) });
    return;
  }

  if (!fromTokenContract || !toTokenContract || !amountIn) {
    res.status(400).json({ error: "fromTokenContract, toTokenContract, and amountIn required" });
    return;
  }

  try {
    await handleSwapRequest(res, {
      walletAddress,
      fromTokenContract,
      toTokenContract,
      amountIn: String(amountIn),
      minAmountOut: minAmountOut != null ? String(minAmountOut) : undefined,
      slippageBps: Number(slippageBps) || 50,
      stepId,
    });
  } catch (e: unknown) {
    sendStellarError(res, e, { wallet: walletAddress, operation: "swap" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/stellar/add-liquidity — build add-liquidity XDR
// ---------------------------------------------------------------------------
router.post("/stellar/add-liquidity", async (req, res): Promise<void> => {
  const {
    walletAddress,
    poolContract: poolContractBody,
    token0Contract,
    token1Contract,
    tickLower,
    tickUpper,
    amount0Desired,
    amount1Desired,
    stepId,
  } = req.body;

  if (!walletAddress) {
    res.status(400).json({ error: "walletAddress required" });
    return;
  }

  let config;
  try {
    config = requireContracts();
  } catch (e: unknown) {
    res.status(503).json({ error: String(e) });
    return;
  }

  if (!token0Contract || !token1Contract || !amount0Desired || !amount1Desired) {
    res.status(400).json({ error: "token0Contract, token1Contract, amount0Desired, amount1Desired required" });
    return;
  }

  try {
    const StellarSdk = await getStellarSdk();
    if (!StellarSdk.StrKey.isValidEd25519PublicKey(walletAddress)) {
      res.status(400).json({ error: "Invalid wallet address" });
      return;
    }
    if (!StellarSdk.StrKey.isValidContract(token0Contract) || !StellarSdk.StrKey.isValidContract(token1Contract)) {
      res.status(400).json({ error: "Invalid token contract address" });
      return;
    }

    const poolAddress = poolContractBody || config.pool;
    if (!poolAddress || !StellarSdk.StrKey.isValidContract(poolAddress)) {
      res.status(400).json({ error: "Valid poolContract required" });
      return;
    }

    const { token0, token1, amount0, amount1 } = canonicalizeTokenPair(
      token0Contract,
      token1Contract,
      String(amount0Desired),
      String(amount1Desired),
    );

    const range = fullRangeTicks();
    const lower = tickLower ?? range.tickLower;
    const upper = tickUpper ?? range.tickUpper;
    try {
      assertValidTickRange(lower, upper);
    } catch (e: unknown) {
      res.status(400).json({ error: String(e) });
      return;
    }
    const amount0Bn = BigInt(amount0);
    const amount1Bn = BigInt(amount1);

    const server = rpcServer(StellarSdk);
    const sqrtPrice = await simulatePoolSqrtPrice(StellarSdk, server, poolAddress);
    const liquidity = computeLiquidity(
      sqrtPrice,
      tickToSqrtQ32(lower),
      tickToSqrtQ32(upper),
      amount0Bn,
      amount1Bn,
    );

    if (liquidity === 0n) {
      res.status(422).json({
        error:
          "Computed zero liquidity for these amounts. Enter non-zero values on both sides of the pool.",
      });
      return;
    }

    const xlmContract = config.tokens.XLM;
    const faucetTx: string[] = [];
    const deployerSecret = process.env.DEPLOYER_SECRET_KEY;
    const fundingCtx: LiquidityFundingCtx = {
      StellarSdk,
      server,
      config,
      walletAddress,
      deployerSecret,
      faucetTx,
    };

    const wrap0 = await ensureLiquidityTokenBalance(fundingCtx, token0, amount0Bn);
    const wrap1 = await ensureLiquidityTokenBalance(fundingCtx, token1, amount1Bn);

    const maxApprove = BigInt("9223372036854775807");
    const token0C = new StellarSdk.Contract(token0);
    const token1C = new StellarSdk.Contract(token1);
    const poolC = new StellarSdk.Contract(poolAddress);
    const walletSc = new StellarSdk.Address(walletAddress);
    const poolSc = new StellarSdk.Address(poolAddress);
    const SOROBAN_FEE = "100000";

    async function singleOpXdr(
      operation: xdr.Operation,
    ): Promise<string> {
      const account = await server.getAccount(walletAddress);
      const tx = new StellarSdk.TransactionBuilder(account, {
        fee: SOROBAN_FEE,
        networkPassphrase: TESTNET_PASSPHRASE,
      })
        .addOperation(operation)
        .setTimeout(300)
        .build();
      const prepared = await server.prepareTransaction(tx);
      return prepared.toXDR();
    }

    const stepPlan: Array<{ id: string; label: string }> = [];
    if (wrap0 > 0n) {
      stepPlan.push({ id: "wrap-token0", label: "Wrap XLM (token 0)" });
    }
    if (wrap1 > 0n) {
      stepPlan.push({ id: "wrap-token1", label: "Wrap XLM (token 1)" });
    }
    stepPlan.push({ id: "approve-token0", label: "Approve pool (token 0)" });
    stepPlan.push({ id: "approve-token1", label: "Approve pool (token 1)" });
    stepPlan.push({ id: "mint", label: "Mint liquidity position" });

    if (stepId) {
      const step = stepPlan.find((s) => s.id === stepId);
      if (!step) {
        res.status(400).json({ error: `Unknown stepId "${stepId}"` });
        return;
      }

      let operation: xdr.Operation;
      if (stepId === "wrap-token0" || stepId === "wrap-token1") {
        const wrapToken = stepId === "wrap-token0" ? token0 : token1;
        const wrapNeed = stepId === "wrap-token0" ? amount0Bn : amount1Bn;
        if (wrapToken !== xlmContract) {
          res.status(400).json({ error: "Wrap step not needed" });
          return;
        }
        const balNow = await simulateContractBalance(StellarSdk, server, wrapToken, walletAddress);
        const wrapNow = balNow < wrapNeed ? wrapNeed - balNow : 0n;
        if (wrapNow <= 0n) {
          res.status(400).json({ error: "Wrap step not needed" });
          return;
        }
        const wrapTokenC = stepId === "wrap-token0" ? token0C : token1C;
        operation = wrapTokenC.call(
          "transfer",
          walletSc.toScVal(),
          walletSc.toScVal(),
          StellarSdk.nativeToScVal(wrapNow, { type: "i128" }),
        );
      } else if (stepId === "approve-token0" || stepId === "approve-token1") {
        const approveTokenC = stepId === "approve-token0" ? token0C : token1C;
        const latestNow = await server.getLatestLedger();
        operation = approveTokenC.call(
          "approve",
          walletSc.toScVal(),
          poolSc.toScVal(),
          StellarSdk.nativeToScVal(maxApprove, { type: "i128" }),
          StellarSdk.nativeToScVal(latestNow.sequence + 100_000, { type: "u32" }),
        );
      } else {
        operation = poolC.call(
          "mint",
          walletSc.toScVal(),
          StellarSdk.nativeToScVal(lower, { type: "i32" }),
          StellarSdk.nativeToScVal(upper, { type: "i32" }),
          StellarSdk.nativeToScVal(liquidity, { type: "u128" }),
        );
      }

      res.json({
        stepId,
        label: step.label,
        xdr: await singleOpXdr(operation),
      });
      return;
    }

    res.json({
      steps: stepPlan,
      sequential: true,
      liquidity: liquidity.toString(),
      wrappedXlm:
        wrap0 > 0n || wrap1 > 0n ? (wrap0 + wrap1).toString() : undefined,
      faucetTx: faucetTx.length > 0 ? faucetTx : undefined,
    });
  } catch (e: unknown) {
    sendStellarError(res, e, { wallet: walletAddress, operation: "liquidity" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/stellar/remove-liquidity
// ---------------------------------------------------------------------------
router.post("/stellar/remove-liquidity", async (req, res): Promise<void> => {
  const { walletAddress, poolContract, tickLower, tickUpper, liquidity, amount0Min, amount1Min } = req.body;
  if (!walletAddress) { res.status(400).json({ error: "walletAddress required" }); return; }

  let config;
  try {
    config = requireContracts();
  } catch (e: unknown) {
    res.status(503).json({ error: String(e) });
    return;
  }

  try {
    const StellarSdk = await getStellarSdk();
    const server = rpcServer(StellarSdk);
    const account = await server.getAccount(walletAddress);
    const routerContract = new StellarSdk.Contract(config.router);

    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: "1000000", networkPassphrase: TESTNET_PASSPHRASE,
    })
      .addOperation(routerContract.call("remove_liquidity", scMap(StellarSdk, [
        ["amount0_min", StellarSdk.nativeToScVal(BigInt(amount0Min || "0"), { type: "u128" })],
        ["amount1_min", StellarSdk.nativeToScVal(BigInt(amount1Min || "0"), { type: "u128" })],
        ["deadline", StellarSdk.nativeToScVal(BigInt(Math.floor(Date.now() / 1000) + 300), { type: "u64" })],
        ["liquidity", StellarSdk.nativeToScVal(BigInt(liquidity), { type: "u128" })],
        ["pool", addressScVal(StellarSdk, poolContract)],
        ["recipient", addressScVal(StellarSdk, walletAddress)],
        ["tick_lower", StellarSdk.nativeToScVal(tickLower ?? fullRangeTicks().tickLower, { type: "i32" })],
        ["tick_upper", StellarSdk.nativeToScVal(tickUpper ?? fullRangeTicks().tickUpper, { type: "i32" })],
      ])))
      .setTimeout(300)
      .build();

    const prepared = await server.prepareTransaction(tx);
    res.json({ xdr: prepared.toXDR() });
  } catch (e: unknown) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/stellar/stake — stake LP position in farm
// ---------------------------------------------------------------------------
router.post("/stellar/stake", async (req, res): Promise<void> => {
  const {
    walletAddress,
    poolContract,
    tickLower,
    tickUpper,
    liquidity,
    lockWeeks,
    autoCompound,
    stakeMax,
  } = req.body;
  if (!walletAddress) { res.status(400).json({ error: "walletAddress required" }); return; }
  if (!poolContract) { res.status(400).json({ error: "poolContract required" }); return; }

  let config;
  try {
    config = requireContracts();
  } catch (e: unknown) {
    res.status(503).json({ error: String(e) });
    return;
  }

  try {
    const range = fullRangeTicks();
    const lower = tickLower ?? range.tickLower;
    const upper = tickUpper ?? range.tickUpper;
    assertValidTickRange(lower, upper);

    const weeks = Number(lockWeeks ?? 1);
    if (!Number.isFinite(weeks) || weeks < 1 || weeks > 156) {
      res.status(400).json({ error: "lockWeeks must be between 1 and 156" });
      return;
    }

    let liquidityBn: bigint;
    if (stakeMax || !liquidity || String(liquidity) === "0") {
      const StellarSdk = await getStellarSdk();
      const server = rpcServer(StellarSdk);
      const source = await server.getAccount(SIM_SOURCE);
      const pool = new StellarSdk.Contract(poolContract);
      const tx = new StellarSdk.TransactionBuilder(source, {
        fee: "100000",
        networkPassphrase: TESTNET_PASSPHRASE,
      })
        .addOperation(
          pool.call(
            "get_position",
            new StellarSdk.Address(walletAddress).toScVal(),
            StellarSdk.nativeToScVal(lower, { type: "i32" }),
            StellarSdk.nativeToScVal(upper, { type: "i32" }),
          ),
        )
        .setTimeout(30)
        .build();
      const sim = await server.simulateTransaction(tx);
      if (StellarSdk.rpc.Api.isSimulationError(sim) || !sim.result?.retval) {
        res.status(422).json({ error: "No LP position found for this pool and tick range. Add liquidity on Pools first." });
        return;
      }
      const val = sim.result.retval;
      let lpLiq = 0n;
      if (val.switch().name === "scvMap") {
        for (const e of val.map() ?? []) {
          if (e.key().sym().toString() === "liquidity") lpLiq = StellarSdk.scValToBigInt(e.val());
        }
      } else {
        const vec = val.vec() ?? [];
        if (vec.length >= 1) lpLiq = StellarSdk.scValToBigInt(vec[0]);
      }
      const existing = await readFarmStake(walletAddress, poolContract, lower, upper);
      const staked = existing ? BigInt(existing.liquidity) : 0n;
      liquidityBn = lpLiq > staked ? lpLiq - staked : 0n;
    } else {
      liquidityBn = BigInt(String(liquidity));
    }

    if (liquidityBn <= 0n) {
      res.status(422).json({
        error: "No unstaked LP liquidity available. Add liquidity on Pools or unstake less than your full position.",
      });
      return;
    }

    const StellarSdk = await getStellarSdk();
    const server = rpcServer(StellarSdk);
    const account = await server.getAccount(walletAddress);
    const farm = new StellarSdk.Contract(config.farm);

    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: "100000", networkPassphrase: TESTNET_PASSPHRASE,
    })
      .addOperation(farm.call(
        "stake",
        new StellarSdk.Address(walletAddress).toScVal(),
        new StellarSdk.Address(poolContract).toScVal(),
        StellarSdk.nativeToScVal(lower, { type: "i32" }),
        StellarSdk.nativeToScVal(upper, { type: "i32" }),
        StellarSdk.nativeToScVal(liquidityBn, { type: "u128" }),
        StellarSdk.nativeToScVal(weeks, { type: "u32" }),
        StellarSdk.nativeToScVal(!!autoCompound, { type: "bool" }),
      ))
      .setTimeout(300)
      .build();

    const prepared = await server.prepareTransaction(tx);
    res.json({ xdr: prepared.toXDR(), liquidity: liquidityBn.toString() });
  } catch (e: unknown) {
    sendStellarError(res, e, { wallet: walletAddress });
  }
});

// ---------------------------------------------------------------------------
// POST /api/stellar/claim — claim farm rewards
// ---------------------------------------------------------------------------
router.post("/stellar/claim", async (req, res): Promise<void> => {
  const { walletAddress, poolContract, tickLower, tickUpper } = req.body;
  if (!walletAddress) { res.status(400).json({ error: "walletAddress required" }); return; }

  let config;
  try {
    config = requireContracts();
  } catch (e: unknown) {
    res.status(503).json({ error: String(e) });
    return;
  }

  try {
    const StellarSdk = await getStellarSdk();
    const server = rpcServer(StellarSdk);
    const account = await server.getAccount(walletAddress);
    const farm = new StellarSdk.Contract(config.farm);

    const range = fullRangeTicks();
    const lower = tickLower ?? range.tickLower;
    const upper = tickUpper ?? range.tickUpper;

    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: "100000", networkPassphrase: TESTNET_PASSPHRASE,
    })
      .addOperation(farm.call(
        "claim",
        new StellarSdk.Address(walletAddress).toScVal(),
        new StellarSdk.Address(poolContract).toScVal(),
        StellarSdk.nativeToScVal(lower, { type: "i32" }),
        StellarSdk.nativeToScVal(upper, { type: "i32" }),
      ))
      .setTimeout(300)
      .build();

    const prepared = await server.prepareTransaction(tx);
    res.json({ xdr: prepared.toXDR() });
  } catch (e: unknown) {
    sendStellarError(res, e, { wallet: walletAddress });
  }
});

// ---------------------------------------------------------------------------
// POST /api/stellar/unstake — unstake LP from farm (after lock expires)
// ---------------------------------------------------------------------------
router.post("/stellar/unstake", async (req, res): Promise<void> => {
  const { walletAddress, poolContract, tickLower, tickUpper, liquidity, unstakeMax } = req.body;
  if (!walletAddress) { res.status(400).json({ error: "walletAddress required" }); return; }
  if (!poolContract) { res.status(400).json({ error: "poolContract required" }); return; }

  let config;
  try {
    config = requireContracts();
  } catch (e: unknown) {
    res.status(503).json({ error: String(e) });
    return;
  }

  try {
    const range = fullRangeTicks();
    const lower = tickLower ?? range.tickLower;
    const upper = tickUpper ?? range.tickUpper;

    let liquidityBn: bigint;
    if (unstakeMax || !liquidity) {
      const stake = await readFarmStake(walletAddress, poolContract, lower, upper);
      if (!stake) {
        res.status(422).json({ error: "No staked position found for this pool." });
        return;
      }
      liquidityBn = BigInt(stake.liquidity);
    } else {
      liquidityBn = BigInt(String(liquidity));
    }

    if (liquidityBn <= 0n) {
      res.status(422).json({ error: "Unstake amount must be greater than zero." });
      return;
    }

    const StellarSdk = await getStellarSdk();
    const server = rpcServer(StellarSdk);
    const account = await server.getAccount(walletAddress);
    const farm = new StellarSdk.Contract(config.farm);

    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: "100000", networkPassphrase: TESTNET_PASSPHRASE,
    })
      .addOperation(farm.call(
        "unstake",
        new StellarSdk.Address(walletAddress).toScVal(),
        new StellarSdk.Address(poolContract).toScVal(),
        StellarSdk.nativeToScVal(lower, { type: "i32" }),
        StellarSdk.nativeToScVal(upper, { type: "i32" }),
        StellarSdk.nativeToScVal(liquidityBn, { type: "u128" }),
      ))
      .setTimeout(300)
      .build();

    const prepared = await server.prepareTransaction(tx);
    res.json({ xdr: prepared.toXDR(), liquidity: liquidityBn.toString() });
  } catch (e: unknown) {
    sendStellarError(res, e, { wallet: walletAddress });
  }
});

// ---------------------------------------------------------------------------
// POST /api/stellar/mint-test-tokens — dev faucet for deployed Soroban USDC
// ---------------------------------------------------------------------------
router.post("/stellar/mint-test-tokens", async (req, res): Promise<void> => {
  const secret = process.env.DEPLOYER_SECRET_KEY;
  if (!secret) {
    res.status(503).json({
      error: "Test token faucet disabled. Set DEPLOYER_SECRET_KEY in the API environment.",
    });
    return;
  }

  const { walletAddress, amount } = req.body as { walletAddress?: string; amount?: string };
  if (!walletAddress) {
    res.status(400).json({ error: "walletAddress required" });
    return;
  }

  let config;
  try {
    config = requireContracts();
  } catch (e: unknown) {
    res.status(503).json({ error: String(e) });
    return;
  }

  const usdcContract = config.poolUsdc || config.tokens.pUSDC;
  if (!usdcContract) {
    res.status(503).json({ error: "USDC_TOKEN_CONTRACT (pUSDC) not configured" });
    return;
  }

  try {
    const StellarSdk = await getStellarSdk();
    if (!StellarSdk.StrKey.isValidEd25519PublicKey(walletAddress)) {
      res.status(400).json({ error: "Invalid wallet address" });
      return;
    }

    const deployer = StellarSdk.Keypair.fromSecret(secret);
    const server = rpcServer(StellarSdk);
    const account = await server.getAccount(deployer.publicKey());
    const token = new StellarSdk.Contract(usdcContract);
    const mintAmount = BigInt(amount || "1000000000"); // default 1000 USDC (6 decimals)

    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: "1000000",
      networkPassphrase: TESTNET_PASSPHRASE,
    })
      .addOperation(
        token.call(
          "mint",
          new StellarSdk.Address(walletAddress).toScVal(),
          StellarSdk.nativeToScVal(mintAmount, { type: "i128" }),
        ),
      )
      .setTimeout(300)
      .build();

    const prepared = await server.prepareTransaction(tx);
    prepared.sign(deployer);
    const sent = await server.sendTransaction(prepared);
    if (sent.status === "ERROR") {
      res.status(422).json({ error: sent.errorResult?.toXDR("base64") ?? "Mint transaction failed" });
      return;
    }

    res.json({
      hash: sent.hash,
      symbol: "pUSDC",
      contract: usdcContract,
      amount: mintAmount.toString(),
      message: "Minted pUSDC (pool token) to your wallet. You still need wrapped XLM for the other side of the pool.",
    });
  } catch (e: unknown) {
    sendStellarError(res, e, { wallet: walletAddress });
  }
});

// ---------------------------------------------------------------------------
// POST /api/stellar/limit-order — IOC fill or on-chain resting order
// ---------------------------------------------------------------------------
router.post("/stellar/limit-order", async (req, res): Promise<void> => {
  const {
    walletAddress,
    fromContract,
    toContract,
    amount,
    limitPrice,
    orderType = "Limit",
    expiryHours = 72,
    stepId,
  } = req.body;

  if (!walletAddress) {
    res.status(400).json({ error: "walletAddress required" });
    return;
  }

  let config;
  try {
    config = requireContracts();
  } catch (e: unknown) {
    res.status(503).json({ error: String(e) });
    return;
  }

  if (!config.orders) {
    res.status(503).json({ error: "ORDERS_CONTRACT not configured. Run: npx tsx scripts/src/redeploy-orders.ts" });
    return;
  }

  if (!fromContract || !toContract || amount == null || limitPrice == null) {
    res.status(400).json({ error: "fromContract, toContract, amount, and limitPrice required" });
    return;
  }

  try {
    const StellarSdk = await getStellarSdk();
    if (!StellarSdk.StrKey.isValidEd25519PublicKey(walletAddress)) {
      res.status(400).json({ error: "Invalid wallet address" });
      return;
    }
    if (!StellarSdk.StrKey.isValidContract(fromContract) || !StellarSdk.StrKey.isValidContract(toContract)) {
      res.status(400).json({ error: "Invalid token contract address" });
      return;
    }

    const server = rpcServer(StellarSdk);
    const amountInBn = parseAmountIn(String(amount));
    const limitPriceBn = parseAmountIn(String(limitPrice));
    if (amountInBn <= 0n || limitPriceBn <= 0n) {
      res.status(400).json({ error: "amount and limitPrice must be greater than zero" });
      return;
    }

    const fromDecimals = decimalsForContract(fromContract, config);
    const toDecimals = decimalsForContract(toContract, config);
    const minOutBn = amountInBn * limitPriceBn / 10n ** BigInt(fromDecimals);

    const poolInfo = await resolvePoolForTokens(
      StellarSdk,
      server,
      config,
      fromContract,
      toContract,
    );
    if (!poolInfo) {
      res.status(422).json({ error: "Pool not found for this token pair." });
      return;
    }

    const quoted = await quotePoolSwapOutput(
      StellarSdk,
      server,
      poolInfo.address,
      fromContract,
      amountInBn,
    );

    if (quoted >= minOutBn) {
      await handleSwapRequest(res, {
        walletAddress,
        fromTokenContract: fromContract,
        toTokenContract: toContract,
        amountIn: String(amount),
        minAmountOut: minOutBn.toString(),
        slippageBps: 0,
        stepId,
      });
      return;
    }

    const xlmContract = config.tokens.XLM;
    const fromBal = await simulateContractBalance(StellarSdk, server, fromContract, walletAddress);
    const wrapAmount =
      fromContract === xlmContract && fromBal < amountInBn ? amountInBn - fromBal : 0n;

    const token0 = await poolToken0ForPool(StellarSdk, server, poolInfo.address);
    const humanPrice = Number(limitPriceBn) / 10 ** toDecimals;
    const triggerSqrt = displayPriceToPoolSqrt(humanPrice, fromContract, token0);
    const zeroForOne = fromContract === token0;
    const latest = await server.getLatestLedger();
    const expiryLedger = expiryLedgerFromHours(Number(expiryHours) || 0, latest.sequence);
    const orderTypeCode = orderTypeToCode(String(orderType));

    const walletSc = new StellarSdk.Address(walletAddress);
    const fromTokenC = new StellarSdk.Contract(fromContract);
    const ordersC = new StellarSdk.Contract(config.orders);
    const SOROBAN_FEE = "100000";

    async function singleOpXdr(operation: xdr.Operation): Promise<string> {
      const account = await server.getAccount(walletAddress);
      const tx = new StellarSdk.TransactionBuilder(account, {
        fee: SOROBAN_FEE,
        networkPassphrase: TESTNET_PASSPHRASE,
      })
        .addOperation(operation)
        .setTimeout(300)
        .build();
      const prepared = await server.prepareTransaction(tx);
      return prepared.toXDR();
    }

    const stepPlan: Array<{ id: string; label: string }> = [];
    if (wrapAmount > 0n) {
      stepPlan.push({ id: "wrap-xlm", label: "Wrap XLM for order" });
    }
    stepPlan.push({ id: "place-order", label: "Place resting order" });

    if (stepId) {
      const step = stepPlan.find((s) => s.id === stepId);
      if (!step) {
        res.status(400).json({ error: `Unknown stepId "${stepId}"` });
        return;
      }

      let operation: xdr.Operation;
      if (stepId === "wrap-xlm") {
        const balNow = await simulateContractBalance(StellarSdk, server, fromContract, walletAddress);
        const wrapNow =
          fromContract === xlmContract && balNow < amountInBn ? amountInBn - balNow : 0n;
        if (wrapNow <= 0n) {
          res.status(400).json({ error: "Wrap step not needed" });
          return;
        }
        operation = fromTokenC.call(
          "transfer",
          walletSc.toScVal(),
          walletSc.toScVal(),
          StellarSdk.nativeToScVal(wrapNow, { type: "i128" }),
        );
      } else {
        operation = ordersC.call(
          "place_order",
          walletSc.toScVal(),
          new StellarSdk.Address(poolInfo.address).toScVal(),
          new StellarSdk.Address(fromContract).toScVal(),
          StellarSdk.nativeToScVal(zeroForOne, { type: "bool" }),
          StellarSdk.nativeToScVal(amountInBn, { type: "u128" }),
          StellarSdk.nativeToScVal(minOutBn, { type: "u128" }),
          StellarSdk.nativeToScVal(triggerSqrt, { type: "u128" }),
          StellarSdk.nativeToScVal(orderTypeCode, { type: "u32" }),
          StellarSdk.nativeToScVal(expiryLedger, { type: "u32" }),
        );
      }

      res.json({
        stepId,
        label: step.label,
        xdr: await singleOpXdr(operation),
        resting: true,
      });
      return;
    }

    res.json({
      steps: stepPlan,
      sequential: true,
      resting: true,
      quotedOut: quoted.toString(),
      minOut: minOutBn.toString(),
    });
  } catch (e: unknown) {
    sendStellarError(res, e, { wallet: walletAddress, operation: "limit-order" });
  }
});

async function poolToken0ForPool(
  StellarSdk: StellarSdk,
  server: ReturnType<typeof rpcServer>,
  poolAddress: string,
): Promise<string> {
  const source = await server.getAccount(SIM_SOURCE);
  const pool = new StellarSdk.Contract(poolAddress);
  const tx = new StellarSdk.TransactionBuilder(source, {
    fee: "100000",
    networkPassphrase: TESTNET_PASSPHRASE,
  })
    .addOperation(pool.call("token0"))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) throw new Error(String(sim.error));
  const contractIdBytes = sim.result!.retval!.address().contractId() as unknown as Uint8Array;
  return StellarSdk.StrKey.encodeContract(Buffer.from(contractIdBytes));
}

// ---------------------------------------------------------------------------
// POST /api/stellar/cancel-order — cancel resting order
// ---------------------------------------------------------------------------
router.post("/stellar/cancel-order", async (req, res): Promise<void> => {
  const { walletAddress, orderId } = req.body;
  if (!walletAddress) {
    res.status(400).json({ error: "walletAddress required" });
    return;
  }
  if (orderId == null) {
    res.status(400).json({ error: "orderId required" });
    return;
  }

  let config;
  try {
    config = requireContracts();
  } catch (e: unknown) {
    res.status(503).json({ error: String(e) });
    return;
  }
  if (!config.orders) {
    res.status(503).json({ error: "ORDERS_CONTRACT not configured" });
    return;
  }

  try {
    const StellarSdk = await getStellarSdk();
    const server = rpcServer(StellarSdk);
    const account = await server.getAccount(walletAddress);
    const orders = new StellarSdk.Contract(config.orders);
    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: "100000",
      networkPassphrase: TESTNET_PASSPHRASE,
    })
      .addOperation(
        orders.call(
          "cancel_order",
          new StellarSdk.Address(walletAddress).toScVal(),
          StellarSdk.nativeToScVal(BigInt(String(orderId)), { type: "u64" }),
        ),
      )
      .setTimeout(300)
      .build();
    const prepared = await server.prepareTransaction(tx);
    res.json({ xdr: prepared.toXDR() });
  } catch (e: unknown) {
    sendStellarError(res, e, { wallet: walletAddress, operation: "cancel-order" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/stellar/orders?wallet= — open resting orders for wallet
// ---------------------------------------------------------------------------
router.get("/stellar/orders", async (req, res): Promise<void> => {
  const wallet = typeof req.query.wallet === "string" ? req.query.wallet : undefined;
  if (!wallet) {
    res.status(400).json({ error: "wallet query required" });
    return;
  }

  try {
    requireContracts();
  } catch (e: unknown) {
    res.status(503).json({ error: String(e) });
    return;
  }

  try {
    const orders = await listWalletOrders(wallet);
    res.json(orders);
  } catch (e: unknown) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/stellar/order-book?pool=&from=&to=
// ---------------------------------------------------------------------------
router.get("/stellar/order-book", async (req, res): Promise<void> => {
  const pool = typeof req.query.pool === "string" ? req.query.pool : undefined;
  const from = typeof req.query.from === "string" ? req.query.from : "XLM";
  const to = typeof req.query.to === "string" ? req.query.to : "pUSDC";

  if (!pool) {
    res.status(400).json({ error: "pool query required" });
    return;
  }

  try {
    requireContracts();
  } catch (e: unknown) {
    res.status(503).json({ error: String(e) });
    return;
  }

  try {
    const book = await buildOrderBook(pool, from, to);
    res.json(book);
  } catch (e: unknown) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------------------------------------------------------------------------
// GET/POST /api/stellar/keeper-tick — order keeper (Vercel cron uses GET)
// ---------------------------------------------------------------------------
async function handleKeeperTick(
  req: { headers: { authorization?: string } },
  res: Response,
): Promise<void> {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${cronSecret}`) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
  }

  try {
    requireContracts();
  } catch (e: unknown) {
    res.status(503).json({ error: String(e) });
    return;
  }

  try {
    const result = await runOrderKeeperOnce();
    res.json(result);
  } catch (e: unknown) {
    res.status(500).json({ error: String(e) });
  }
}

router.get("/stellar/keeper-tick", (req, res) => void handleKeeperTick(req, res));
router.post("/stellar/keeper-tick", (req, res) => void handleKeeperTick(req, res));

// ---------------------------------------------------------------------------
// GET /api/stellar/farm-stats — aggregate farm emissions
// ---------------------------------------------------------------------------
router.get("/stellar/farm-stats", async (req, res): Promise<void> => {
  try {
    requireContracts();
  } catch (e: unknown) {
    res.status(503).json({ error: String(e) });
    return;
  }

  try {
    const wallet = typeof req.query.wallet === "string" ? req.query.wallet : undefined;
    const overview = await getOnChainFarmOverview(wallet);
    res.json(overview);
  } catch (e: unknown) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/stellar/farm-pools?wallet= — pools with live farm state
// ---------------------------------------------------------------------------
router.get("/stellar/farm-pools", async (req, res): Promise<void> => {
  try {
    requireContracts();
  } catch (e: unknown) {
    res.status(503).json({ error: String(e) });
    return;
  }

  try {
    const wallet = typeof req.query.wallet === "string" ? req.query.wallet : undefined;
    const pools = await listOnChainFarmPools(wallet);
    res.json(pools);
  } catch (e: unknown) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/stellar/farm-positions?wallet=...
// ---------------------------------------------------------------------------
router.get("/stellar/farm-positions", async (req, res): Promise<void> => {
  const { wallet } = req.query;
  if (!wallet || typeof wallet !== "string") {
    res.status(400).json({ error: "wallet required" });
    return;
  }

  try {
    requireContracts();
  } catch (e: unknown) {
    res.status(503).json({ error: String(e) });
    return;
  }

  try {
    const positions = await getOnChainFarmPositions(wallet);
    res.json(positions);
  } catch (e: unknown) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/stellar/user-positions?wallet= — full LP + farm breakdown per pool
// Returns only pools where the wallet has any liquidity (staked or unstaked).
// Fields: token0Amount, token1Amount, userValueUsd, lpBalance, stakedBalance,
//         aprPercent, rewardsEarnedUsd, pendingRewardsHuman
// ---------------------------------------------------------------------------
router.get("/stellar/user-positions", async (req, res): Promise<void> => {
  const { wallet } = req.query;
  if (!wallet || typeof wallet !== "string") {
    res.status(400).json({ error: "wallet required" });
    return;
  }

  try {
    requireContracts();
  } catch (e: unknown) {
    res.status(503).json({ error: String(e) });
    return;
  }

  try {
    const pools = await listOnChainFarmPools(wallet);
    // Only return pools where the user actually has something
    const positions = pools.filter(
      (p) =>
        (p.lpLiquidity && p.lpLiquidity !== "0") ||
        (p.stakedLiquidity && p.stakedLiquidity !== "0"),
    );
    res.json(positions);
  } catch (e: unknown) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/stellar/create-pool — deploy a new pool via the factory contract
// ---------------------------------------------------------------------------
router.post("/stellar/create-pool", async (req, res): Promise<void> => {
  const { walletAddress, token0Contract, token1Contract, feeTier = "Medium" } = req.body;
  if (!walletAddress) { res.status(400).json({ error: "walletAddress required" }); return; }
  if (!token0Contract || !token1Contract) {
    res.status(400).json({ error: "token0Contract and token1Contract required" });
    return;
  }

  let config;
  try {
    config = requireContracts();
  } catch (e: unknown) {
    res.status(503).json({ error: String(e) });
    return;
  }

  if (!config.factory) {
    res.status(503).json({ error: "FACTORY_CONTRACT not configured." });
    return;
  }

  try {
    const StellarSdk = await getStellarSdk();
    if (!StellarSdk.StrKey.isValidEd25519PublicKey(walletAddress)) {
      res.status(400).json({ error: "Invalid wallet address" });
      return;
    }
    if (
      !StellarSdk.StrKey.isValidContract(token0Contract) ||
      !StellarSdk.StrKey.isValidContract(token1Contract)
    ) {
      res.status(400).json({ error: "Invalid token contract address" });
      return;
    }

    // Canonicalize: factory expects token0 < token1 lexicographically
    const [orderedToken0, orderedToken1] =
      token0Contract < token1Contract
        ? [token0Contract, token1Contract]
        : [token1Contract, token0Contract];

    const server = rpcServer(StellarSdk);
    const account = await server.getAccount(walletAddress);
    const factory = new StellarSdk.Contract(config.factory);
    const feeTierVal = feeTierScVal(StellarSdk, String(feeTier) as "Low" | "Medium" | "High");

    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: "1000000",
      networkPassphrase: TESTNET_PASSPHRASE,
    })
      .addOperation(
        factory.call(
          "create_pool",
          new StellarSdk.Address(orderedToken0).toScVal(),
          new StellarSdk.Address(orderedToken1).toScVal(),
          feeTierVal,
        ),
      )
      .setTimeout(300)
      .build();

    const prepared = await server.prepareTransaction(tx);
    res.json({ xdr: prepared.toXDR() });
  } catch (e: unknown) {
    sendStellarError(res, e, { wallet: walletAddress, operation: "create-pool" });
  }
});

export default router;
