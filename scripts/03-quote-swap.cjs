const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const anchor = require("@coral-xyz/anchor");
const { getMint, TOKEN_PROGRAM_ID } = require("@solana/spl-token");
const { PoolInfoLayout, TickUtil } = require("@raydium-io/raydium-sdk-v2");
const { Connection, Keypair, PublicKey, ComputeBudgetProgram,
  TransactionMessage, VersionedTransaction } = anchor.web3;

async function main() {
  const rpc = process.env.SOLANA_RPC_URL;
  if (!rpc || new URL(rpc).hostname !== "devnet.helius-rpc.com") {
    throw new Error("Нужен Helius Devnet RPC");
  }

  const connection = new Connection(rpc, "confirmed");
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
    fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8")
  )));
  const idl = require("../target/idl/simple_vault.json");
  if (idl.address !== "7Uk6iKLVg1JELBsXuqwHMzfu87QzzpUsGYW8VSaoYa8f") {
    throw new Error("Неверный адрес программы задания 12");
  }
  const program = new anchor.Program(idl, new anchor.AnchorProvider(
    connection, new anchor.Wallet(admin), { commitment: "confirmed" }
  ));
  const pool = require("../config/raydium-pool.json");
  const position = require("../config/raydium-position.json");
  if (pool.network !== "devnet" || position.poolId !== pool.poolId) {
    throw new Error("Данные пула и позиции не совпадают");
  }

  const poolState = new PublicKey(pool.poolId);
  const clmmProgram = new PublicKey(pool.programId);
  const info = await connection.getAccountInfo(poolState, "confirmed");
  if (!info || !info.owner.equals(clmmProgram)) throw new Error("Пул не найден");
  const state = PoolInfoLayout.decode(info.data);
  if (state.tickCurrent < position.tickLower ||
      state.tickCurrent >= position.tickUpper || state.liquidity.isZero()) {
    throw new Error("Цена вышла за диапазон позиции или в пуле нет активной ликвидности");
  }

  const pda = (seed, key) => PublicKey.findProgramAddressSync(
    [Buffer.from(seed), key.toBuffer()], program.programId
  )[0];
  const vaultState = pda("vault", state.mintA);
  const swapStrategy = pda("strategy", vaultState);
  const vault = await program.account.vaultState.fetch(vaultState);
  const strategy = await program.account.swapStrategy.fetch(swapStrategy);
  const mintA = await getMint(connection, state.mintA, "confirmed");
  const mintB = await getMint(connection, state.mintB, "confirmed");
  const amount = 10n * 10n ** BigInt(mintA.decimals);

  const ix = await program.methods.swapTokens(
    new anchor.BN(amount.toString()), new anchor.BN(1), true
  ).accountsStrict({
    vaultState, swapStrategy,
    vaultTokenAccount: vault.vaultTokenAccount,
    secondTokenAccount: strategy.secondAccount,
    poolState, ammConfig: state.configId,
    poolVaultA: state.vaultA, poolVaultB: state.vaultB,
    observationState: new PublicKey(pool.accounts.observationId),
    tickArray: new PublicKey(position.tickArrayUpper),
    admin: admin.publicKey, clmmProgram, tokenProgram: TOKEN_PROGRAM_ID,
  }).remainingAccounts([
    {
      pubkey: new PublicKey(position.tickArrayLower),
      isWritable: true,
      isSigner: false,
    },
  ]).instruction();

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(new TransactionMessage({
    payerKey: admin.publicKey,
    recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 600000 }), ix],
  }).compileToV0Message());
  tx.sign([admin]);

  const { value } = await connection.simulateTransaction(tx, {
    commitment: "confirmed",
    sigVerify: true,
  });
  if (value.err) {
    console.log((value.logs ?? []).join("\n"));
    throw new Error("Симуляция отклонена: " + JSON.stringify(value.err));
  }
  const line = (value.logs ?? []).find(log => log.includes("Vault swap:"));
  const result = line?.match(/input=(\d+), output=(\d+)/);
  if (!result || BigInt(result[1]) !== amount) throw new Error("Результат обмена не найден");

  const output = BigInt(result[2]);
  const minOut = output * 99n / 100n;
  console.log("Текущая цена:", TickUtil.sqrtPriceX64ToPrice(
    state.sqrtPriceX64, mintA.decimals, mintB.decimals
  ).toString());
  console.log("Вход: 10 Mint A");
  console.log("Ожидаемый выход в минимальных единицах Mint B:", output.toString());
  console.log("Минимум при допуске 1%:", minOut.toString());
  console.log("Симуляция успешна. Транзакция не отправлена.");
}

main().then(() => process.exit(0), error => {
  console.error(String(error.message ?? error).replace(/https?:\/\/\S+/g, "[URL скрыт]"));
  process.exit(1);
});
