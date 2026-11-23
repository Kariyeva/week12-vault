use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use raydium_clmm_cpi::{
    cpi,
    program::RaydiumClmm,
    states::{AmmConfig, ObservationState, PoolState, TickArrayState},
};
use crate::{VaultError, VaultState};

pub fn initialize(ctx: Context<InitializeSwap>) -> Result<()> {
    {
        let pool = ctx.accounts.pool_state.load()?;
        let mint_a = pool.token_mint_0;
        let mint_b = pool.token_mint_1;

        require_keys_eq!(
            mint_a, ctx.accounts.vault_state.token_mint,
            VaultError::InvalidSwapPool
        );
        require_keys_eq!(
            mint_b, ctx.accounts.second_mint.key(),
            VaultError::InvalidSwapPool
        );
    }

    let strategy = &mut ctx.accounts.swap_strategy;
    strategy.vault = ctx.accounts.vault_state.key();
    strategy.pool = ctx.accounts.pool_state.key();
    strategy.second_mint = ctx.accounts.second_mint.key();
    strategy.second_account = ctx.accounts.second_token_account.key();
    strategy.bump = ctx.bumps.swap_strategy;

    msg!("Swap strategy initialized: pool={}", strategy.pool);
    Ok(())
}

pub fn execute_swap<'a, 'b, 'c: 'info, 'info>(
    ctx: Context<'a, 'b, 'c, 'info, SwapTokens<'info>>,
    amount_in: u64,
    minimum_out: u64,
    to_second: bool,
) -> Result<()> {
    require!(amount_in > 0 && minimum_out > 0, VaultError::ZeroAmount);
    require!(!ctx.accounts.vault_state.paused, VaultError::VaultPaused);

    {
        let pool = ctx.accounts.pool_state.load()?;
        let mint_a = pool.token_mint_0;
        let mint_b = pool.token_mint_1;
        let vault_a = pool.token_vault_0;
        let vault_b = pool.token_vault_1;

        require_keys_eq!(
            mint_a, ctx.accounts.vault_state.token_mint,
            VaultError::InvalidSwapPool
        );
        require_keys_eq!(
            mint_b, ctx.accounts.swap_strategy.second_mint,
            VaultError::InvalidSwapPool
        );
        require_keys_eq!(
            vault_a, ctx.accounts.pool_vault_a.key(),
            VaultError::InvalidSwapAccount
        );
        require_keys_eq!(
            vault_b, ctx.accounts.pool_vault_b.key(),
            VaultError::InvalidSwapAccount
        );
    }

    let before_base = ctx.accounts.vault_token_account.amount;
    let before_second = ctx.accounts.second_token_account.amount;

    let (input, output, input_vault, output_vault, available) = if to_second {
        (
            ctx.accounts.vault_token_account.to_account_info(),
            ctx.accounts.second_token_account.to_account_info(),
            ctx.accounts.pool_vault_a.to_account_info(),
            ctx.accounts.pool_vault_b.to_account_info(),
            before_base,
        )
    } else {
        (
            ctx.accounts.second_token_account.to_account_info(),
            ctx.accounts.vault_token_account.to_account_info(),
            ctx.accounts.pool_vault_b.to_account_info(),
            ctx.accounts.pool_vault_a.to_account_info(),
            before_second,
        )
    };

    require!(amount_in <= available, VaultError::InsufficientLiquidity);

    if to_second {
        require!(amount_in <= before_base / 2, VaultError::SwapLimitExceeded);
    }

    let mint = ctx.accounts.vault_state.token_mint;
    let bump = [ctx.accounts.vault_state.bump];
    let seeds: &[&[u8]] = &[b"vault", mint.as_ref(), &bump];
    let signer = &[seeds];

    let accounts = cpi::accounts::SwapSingle {
        payer: ctx.accounts.vault_state.to_account_info(),
        amm_config: ctx.accounts.amm_config.to_account_info(),
        pool_state: ctx.accounts.pool_state.to_account_info(),
        input_token_account: input,
        output_token_account: output,
        input_vault,
        output_vault,
        observation_state: ctx.accounts.observation_state.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
        tick_array: ctx.accounts.tick_array.to_account_info(),
    };

    let cpi_context = CpiContext::new_with_signer(
        ctx.accounts.clmm_program.to_account_info(),
        accounts,
        signer,
    ).with_remaining_accounts(ctx.remaining_accounts.to_vec());

    // Exact input; Raydium проверяет minimum_out.
    cpi::swap(cpi_context, amount_in, minimum_out, 0, true)?;

    ctx.accounts.vault_token_account.reload()?;
    ctx.accounts.second_token_account.reload()?;

    let after_base = ctx.accounts.vault_token_account.amount;
    let after_second = ctx.accounts.second_token_account.amount;

    let (spent, received) = if to_second {
        (
            before_base.checked_sub(after_base),
            after_second.checked_sub(before_second),
        )
    } else {
        (
            before_second.checked_sub(after_second),
            after_base.checked_sub(before_base),
        )
    };

    let spent = spent.ok_or(VaultError::MathOverflow)?;
    let received = received.ok_or(VaultError::MathOverflow)?;
    require!(spent == amount_in, VaultError::IncompleteSwap);
    require!(received >= minimum_out, VaultError::SlippageExceeded);

    let vault = &mut ctx.accounts.vault_state;
    vault.total_tokens = after_base;
    vault.swap_active = after_second > 0;

    msg!(
        "Vault swap: input={}, output={}, minimum={}, to_second={}",
        spent, received, minimum_out, to_second
    );
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeSwap<'info> {
    #[account(
        seeds = [b"vault", vault_state.token_mint.as_ref()],
        bump = vault_state.bump,
        has_one = admin @ VaultError::Unauthorized,
    )]
    pub vault_state: Box<Account<'info, VaultState>>,

    #[account(
        init,
        payer = admin,
        space = SwapStrategy::LEN,
        seeds = [b"strategy", vault_state.key().as_ref()],
        bump,
    )]
    pub swap_strategy: Account<'info, SwapStrategy>,

    pub pool_state: AccountLoader<'info, PoolState>,
    pub second_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = admin,
        seeds = [b"vault_second", vault_state.key().as_ref()],
        bump,
        token::mint = second_mint,
        token::authority = vault_state,
    )]
    pub second_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub admin: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SwapTokens<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault_state.token_mint.as_ref()],
        bump = vault_state.bump,
        has_one = admin @ VaultError::Unauthorized,
    )]
    pub vault_state: Box<Account<'info, VaultState>>,

    #[account(
        seeds = [b"strategy", vault_state.key().as_ref()],
        bump = swap_strategy.bump,
        constraint = swap_strategy.vault == vault_state.key()
            @ VaultError::InvalidSwapAccount,
    )]
    pub swap_strategy: Box<Account<'info, SwapStrategy>>,

    #[account(
        mut,
        seeds = [b"vault_tokens", vault_state.token_mint.as_ref()],
        bump,
        address = vault_state.vault_token_account,
        token::mint = vault_state.token_mint,
        token::authority = vault_state,
    )]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [b"vault_second", vault_state.key().as_ref()],
        bump,
        address = swap_strategy.second_account,
        token::mint = swap_strategy.second_mint,
        token::authority = vault_state,
    )]
    pub second_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = swap_strategy.pool)]
    pub pool_state: AccountLoader<'info, PoolState>,

    #[account(address = pool_state.load()?.amm_config)]
    pub amm_config: Box<Account<'info, AmmConfig>>,

    #[account(mut)]
    pub pool_vault_a: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub pool_vault_b: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = pool_state.load()?.observation_key)]
    pub observation_state: AccountLoader<'info, ObservationState>,

    #[account(
        mut,
        constraint = tick_array.load()?.pool_id == pool_state.key()
            @ VaultError::InvalidSwapAccount,
    )]
    pub tick_array: AccountLoader<'info, TickArrayState>,

    pub admin: Signer<'info>,
    pub clmm_program: Program<'info, RaydiumClmm>,
    pub token_program: Program<'info, Token>,
}

#[account]
pub struct SwapStrategy {
    pub vault: Pubkey,
    pub pool: Pubkey,
    pub second_mint: Pubkey,
    pub second_account: Pubkey,
    pub bump: u8,
}

impl SwapStrategy {
    pub const LEN: usize = 8 + 32 * 4 + 1;
}
