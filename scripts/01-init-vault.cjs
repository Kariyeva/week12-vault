const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const anchor = require("@coral-xyz/anchor");
const { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID } = require("@solana/spl-token");
const { Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } = anchor.web3;

async function main() {
  const rpc = process.env.SOLANA_RPC_URL;
  if (!rpc || new URL(rpc).hostname !== "devnet.helius-rpc.com") {
    throw new Error("Нужен Helius Devnet RPC");
  }

  const connection = new Connection(rpc, "confirmed");
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
    fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8")
  )));
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });

  const idl = require("../target/idl/simple_vault.json");
  if (idl.address !== "7Uk6iKLVg1JELBsXuqwHMzfu87QzzpUsGYW8VSaoYa8f") {
    throw new Error("Адрес программы в IDL не совпадает с заданием 12");
  }
  const program = new anchor.Program(idl, provider);
  const pool = require("../config/raydium-pool.json");
  if (pool.network !== "devnet") throw new Error("Ожидался пул Devnet");

  const tokenMint = new PublicKey(pool.mintA);
  const secondMint = new PublicKey(pool.mintB);
  const poolState = new PublicKey(pool.poolId);
  const pda = (seed, key) =>
    PublicKey.findProgramAddressSync([Buffer.from(seed), key.toBuffer()], program.programId)[0];

  const vaultState = pda("vault", tokenMint);
  const vaultTokenAccount = pda("vault_tokens", tokenMint);
  const shareMint = pda("share_mint", tokenMint);
  const swapStrategy = pda("strategy", vaultState);
  const secondTokenAccount = pda("vault_second", vaultState);

  let vault = await program.account.vaultState.fetchNullable(vaultState);
  if (!vault) {
    // Отдельный счёт для комиссии: депозит будет списываться с ATA администратора.
    const feeOwner = pda("week12_fee", vaultState);
    const feeWallet = await getOrCreateAssociatedTokenAccount(
      connection, admin, tokenMint, feeOwner, true, "confirmed"
    );

    const signature = await program.methods.initializeVault().accountsStrict({
      vaultState, vaultTokenAccount, shareMint, tokenMint,
      feeWallet: feeWallet.address, admin: admin.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    }).rpc();
    console.log("Initialize vault:", signature);
    vault = await program.account.vaultState.fetch(vaultState);
  }

  if (!vault.admin.equals(admin.publicKey)) {
    throw new Error("Текущий кошелёк не администратор этого vault");
  }

  let strategy = await program.account.swapStrategy.fetchNullable(swapStrategy);
  if (!strategy) {
    const signature = await program.methods.initializeSwap().accountsStrict({
      vaultState, swapStrategy, poolState, secondMint, secondTokenAccount,
      admin: admin.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    }).rpc();
    console.log("Initialize swap:", signature);
    strategy = await program.account.swapStrategy.fetch(swapStrategy);
  }
  if (!strategy.pool.equals(poolState) || !strategy.secondAccount.equals(secondTokenAccount)) {
    throw new Error("Стратегия привязана к другому пулу или хранилищу");
  }

  console.log("Vault:", vaultState.toBase58());
  console.log("Хранилище Mint A:", vaultTokenAccount.toBase58());
  console.log("Хранилище Mint B:", secondTokenAccount.toBase58());
  console.log("Пул Raydium:", poolState.toBase58());
}

main().catch(error => {
  console.error(String(error.message ?? error).replace(/https?:\/\/\S+/g, "[URL скрыт]"));
  process.exitCode = 1;
});
