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
    new anchor.BN(amount.toString()),
    new anchor.BN((20n * 10n ** BigInt(mintB.decimals)).toString()), true
  ).accountsStrict({
    vaultState, swapStrategy,
    vaultTokenAccount: vault.vaultTokenAccount,
    secondTokenAccount: strategy.secondAccount,
    poolState, ammConfig: state.configId,
    poolVaultA: state.vaultA, poolVaultB: state.vaultB,
    observationState: new PublicKey(pool.accounts.observationId),
    tickArray: new PublicKey(
      state.tickCurrent < 0 ? position.tickArrayLower : position.tickArrayUpper
    ),
    admin: admin.publicKey, clmmProgram, tokenProgram: TOKEN_PROGRAM_ID,
  }).remainingAccounts([
    {
      pubkey: new PublicKey(state.tickCurrent < 0 ? position.tickArrayUpper : position.tickArrayLower),
      isWritable: true,
      isSigner: false,
    },
  ]).instruction();

  const latest = await connection.getLatestBlockhash("confirmed");
  const { blockhash } = latest;
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
  const logs = (value.logs ?? []).join("\\n");
  if (!value.err || !/TooLittleOutput|SlippageExceeded/i.test(logs)) {
    console.log(logs);
    throw new Error("Симуляция не подтвердила отказ из-за минимума. Транзакция не отправлена.");
  }
  const simulatedError = value.err.InstructionError;
  if (!simulatedError || typeof simulatedError[1]?.Custom !== "number") {
    throw new Error("Не удалось определить код отказа. Транзакция не отправлена.");
  }

  const balances = async () => Promise.all(
    [vault.vaultTokenAccount, strategy.secondAccount].map(async key =>
      (await connection.getTokenAccountBalance(key, "confirmed")).value.uiAmountString
    )
  );
  const before = await balances();

  const signature = await connection.sendTransaction(tx, { skipPreflight: true });
  console.log("Подпись отклонённого обмена:", signature);
  const confirmation = await connection.confirmTransaction(
    { signature, ...latest }, "confirmed"
  );
  const actualError = confirmation.value.err?.InstructionError;
  if (actualError?.[0] !== simulatedError[0] ||
      actualError?.[1]?.Custom !== simulatedError[1].Custom) {
    throw new Error("Результат в сети отличается от симуляции. Проверь подпись.");
  }
  const after = await balances();
  if (before.some((amount, i) => amount !== after[i])) {
    throw new Error("Балансы изменились. Проверь подпись.");
  }

  console.log("Обмен отклонён: выход меньше 20 Mint B.");
  console.log("Код ошибки:", actualError[1].Custom);
  console.log("Балансы не изменились:", after[0], "Mint A и", after[1], "Mint B");
  console.log(`https://explorer.solana.com/tx/${signature}?cluster=devnet`);

}

main().then(() => process.exit(0), error => {
  console.error(String(error.message ?? error).replace(/https?:\/\/\S+/g, "[URL скрыт]"));
  process.exit(1);
});
