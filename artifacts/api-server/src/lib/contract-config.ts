import { toContractStrkey } from "./contract-address.js";
import { OFFICIAL_TESTNET_TOKENS } from "./stellar-tokens.js";

const XLM_WRAPPED_DEFAULT = OFFICIAL_TESTNET_TOKENS.XLM.sacContract;
const USDC_DEFAULT = OFFICIAL_TESTNET_TOKENS.USDC.sacContract;
const EURC_DEFAULT = OFFICIAL_TESTNET_TOKENS.EURC.sacContract;

function envContract(key: string): string {
  const raw = process.env[key] || "";
  return raw ? toContractStrkey(raw) : "";
}

export type ContractConfig = {
  factory: string;
  router: string;
  farm: string;
  orders: string;
  pool: string;
  tokens: Record<string, string>;
  /** Pool / DEX USDC (custom deployed token). */
  poolUsdc: string;
  /** Circle USDC Soroban SAC (faucet + trustline). */
  circleUsdc: string;
  circleEurc: string;
  contractsReady: boolean;
};

export function getContractConfig(): ContractConfig {
  const factory = envContract("FACTORY_CONTRACT");
  const router = envContract("ROUTER_CONTRACT");
  const farm = envContract("FARM_CONTRACT");
  const orders = envContract("ORDERS_CONTRACT");
  const pool = envContract("POOL_CONTRACT");

  const tokens: Record<string, string> = {};
  const xlm = envContract("XLM_TOKEN_CONTRACT") || XLM_WRAPPED_DEFAULT;
  const poolUsdc = envContract("USDC_TOKEN_CONTRACT");
  const circleUsdc = envContract("CIRCLE_USDC_TOKEN_CONTRACT") || USDC_DEFAULT;
  const circleEurc = envContract("EURC_TOKEN_CONTRACT") || EURC_DEFAULT;
  const stellar = envContract("STELLAR_TOKEN_CONTRACT");

  if (xlm) tokens.XLM = xlm;
  if (poolUsdc) tokens.pUSDC = poolUsdc;
  if (circleUsdc) tokens.cUSDC = circleUsdc;
  if (circleEurc) tokens.EURC = circleEurc;
  if (stellar) tokens.STELLAR = stellar;

  const contractsReady = !!(factory && router && farm && pool);

  return {
    factory,
    router,
    farm,
    orders,
    pool,
    tokens,
    poolUsdc,
    circleUsdc,
    circleEurc,
    contractsReady,
  };
}

export function requireContracts(): ContractConfig {
  const config = getContractConfig();
  if (!config.contractsReady) {
    throw new Error(
      "Soroban contracts not configured. Run: DEPLOYER_SECRET_KEY=S... pnpm --filter @workspace/scripts run deploy"
    );
  }
  return config;
}

/** Map token symbol → on-chain contract address (for DB merge). */
export function tokenContractBySymbol(): Record<string, string> {
  return getContractConfig().tokens;
}
