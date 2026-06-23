type StellarSdk = typeof import("@stellar/stellar-sdk");

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";

export async function mintTestUsdc(
  StellarSdk: StellarSdk,
  deployerSecret: string,
  usdcContract: string,
  recipient: string,
  amount: bigint,
): Promise<string> {
  const deployer = StellarSdk.Keypair.fromSecret(deployerSecret);
  const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
  const account = await server.getAccount(deployer.publicKey());
  const token = new StellarSdk.Contract(usdcContract);

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase: TESTNET_PASSPHRASE,
  })
    .addOperation(
      token.call(
        "mint",
        new StellarSdk.Address(recipient).toScVal(),
        StellarSdk.nativeToScVal(amount, { type: "i128" }),
      ),
    )
    .setTimeout(300)
    .build();

  const prepared = await server.prepareTransaction(tx);
  prepared.sign(deployer);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR" || !sent.hash) {
    throw new Error(sent.errorResultXdr || "USDC mint failed");
  }

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const result = await server.getTransaction(sent.hash);
    if (result.status === "SUCCESS") return sent.hash;
    if (result.status === "FAILED") throw new Error("USDC mint transaction failed on-chain");
  }
  throw new Error("USDC mint confirmation timed out");
}
