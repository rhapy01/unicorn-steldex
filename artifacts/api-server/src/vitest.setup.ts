/** Keep API tests isolated from local `.env.contracts` (CI and dev machines). */
process.env.SKIP_CONTRACT_ENV = "1";

const CONTRACT_ENV_KEYS = [
  "FACTORY_CONTRACT",
  "ROUTER_CONTRACT",
  "FARM_CONTRACT",
  "ORDERS_CONTRACT",
  "POOL_CONTRACT",
  "XLM_TOKEN_CONTRACT",
  "USDC_TOKEN_CONTRACT",
  "CIRCLE_USDC_TOKEN_CONTRACT",
  "EURC_TOKEN_CONTRACT",
  "STELLAR_TOKEN_CONTRACT",
  "POOLS_JSON",
] as const;

for (const key of CONTRACT_ENV_KEYS) {
  delete process.env[key];
}
