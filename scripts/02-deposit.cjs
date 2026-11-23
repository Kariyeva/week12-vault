const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const anchor = require("@coral-xyz/anchor");
const {
  getAccount, getMint, getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");
const { Connection, Keypair, PublicKey, SystemProgram } = anchor.web3;

async function main() {
  const rpc = process.env.SOLANA_RPC_URL;
  if (!rpc || new URL(rpc).hostname !== "devnet.helius-rpc.com") {
    throw new Error("Нужен Helius Devnet RPC");
  }
  const connection = new Connection(rpc, "confirmed");
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
    fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8")
  )));
  const user = admin.publicKey;
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const idl = require("../target/idl/simple_vault.json");
  if (idl.address !== "7Uk6iKLVg1JELBsXuqwHMzfu87QzzpUsGYW8VSaoYa8f") {
    throw new Error("Неверный адрес программы задания 12");
  }
  const program = new anchor.Program(idl, provider);
  const pool = require("../config/raydium-pool.json");
  const mint = new PublicKey(pool.mintA);
  const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, program.programId)[0];
  const vaultState = pda(Buffer.from("vault"), mint.toBuffer());
  const userCard = pda(Buffer.from("user_card"), vaultState.toBuffer(), user.toBuffer());
  const vault = await program.account.vaultState.fetch(vaultState);
  const { vaultTokenAccount, shareMint, feeWallet } = vault;

  if (!vault.admin.equals(user) || vault.paused || vault.swapActive) {
    throw new Error("Vault не готов к депозиту");
  }

  const mintInfo = await getMint(connection, mint, "confirmed");
  const unit = 10n ** BigInt(mintInfo.decimals);
  const amount = 100n * unit;
  const expected = amount - amount / 100n;
  const before = await getAccount(connection, vaultTokenAccount, "confirmed");
  const existingCard = await program.account.userCard.fetchNullable(userCard);

  if (before.amount === expected && existingCard?.deposited.toString() === amount.toString()) {
    console.log("Депозит уже внесён. Повторная отправка пропущена.");
    console.log("Баланс хранилища Mint A:", before.amount.toString(), "минимальных единиц");
    return;
  }
  if (before.amount !== 0n || !vault.totalShares.isZero()) {
    throw new Error("Vault уже содержит средства или выпущенные shares. Депозит не отправлен.");
  }

  const userTokenAccount = getAssociatedTokenAddressSync(mint, user);
  const source = await getAccount(connection, userTokenAccount, "confirmed");
  if (source.amount < amount) throw new Error("На кошельке меньше 100 Mint A");

  if (!existingCard) {
    await program.methods.createUserCard().accountsStrict({
      vaultState, userCard, user, systemProgram: SystemProgram.programId,
    }).rpc();
  }
  const shareAccount = await getOrCreateAssociatedTokenAccount(
    connection, admin, shareMint, user, false, "confirmed"
  );

  const signature = await program.methods.deposit(new anchor.BN(amount.toString()))
    .accountsStrict({
      vaultState, userCard, vaultTokenAccount, shareMint,
      userTokenAccount, feeWallet, userShareAccount: shareAccount.address,
      user, tokenProgram: TOKEN_PROGRAM_ID,
    }).rpc();

  console.log("Транзакция депозита:", signature);
  const after = await getAccount(connection, vaultTokenAccount, "confirmed");
  if (after.amount !== expected) throw new Error("Баланс после депозита отличается от ожидаемого");
  console.log("Внесено: 100 Mint A");
  console.log("Комиссия: 1 Mint A");
  console.log("В хранилище: 99 Mint A");
}

main().catch(error => {
  console.error(String(error.message ?? error).replace(/https?:\/\/\S+/g, "[URL скрыт]"));
  process.exitCode = 1;
});
