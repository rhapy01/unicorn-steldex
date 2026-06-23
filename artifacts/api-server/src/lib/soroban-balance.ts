type StellarSdk = typeof import("@stellar/stellar-sdk");

const SIM_SOURCE = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

export async function simulateContractBalance(
  StellarSdk: StellarSdk,
  server: InstanceType<StellarSdk["rpc"]["Server"]>,
  contractId: string,
  owner: string,
): Promise<bigint> {
  const contract = new StellarSdk.Contract(contractId);
  const source = await server.getAccount(SIM_SOURCE);
  const tx = new StellarSdk.TransactionBuilder(source, {
    fee: "100000",
    networkPassphrase: TESTNET_PASSPHRASE,
  })
    .addOperation(contract.call("balance", new StellarSdk.Address(owner).toScVal()))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) return 0n;
  const val = sim.result?.retval;
  return val ? StellarSdk.scValToBigInt(val) : 0n;
}
