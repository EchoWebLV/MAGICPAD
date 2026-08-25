use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::MagicPadError;
use crate::state::{Gate, Platform, PlatformConfig};

// ============================================================================
// Platform bootstrap. One PDA holds admin + launch counter and receives
// launch fees + graduation tax (lamports on the account). Fee schedule
// lives on a separate config PDA so the live Platform account never
// reallocs. Admin can set fee/tax and withdraw accumulated lamports.
// ============================================================================

#[derive(Accounts)]
pub struct InitPlatform<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(init, payer = admin, space = 8 + Platform::INIT_SPACE,
        seeds = [PLATFORM_SEED], bump)]
    pub platform: Box<Account<'info, Platform>>,

    #[account(init, payer = admin, space = 8 + PlatformConfig::INIT_SPACE,
        seeds = [CONFIG_SEED], bump)]
    pub config: Box<Account<'info, PlatformConfig>>,

    pub system_program: Program<'info, System>,
}

pub fn init_platform_handler(ctx: Context<InitPlatform>) -> Result<()> {
    let p = &mut ctx.accounts.platform;
    p.admin = ctx.accounts.admin.key();
    p.launch_seq = 0;
    p.bump = ctx.bumps.platform;

    let c = &mut ctx.accounts.config;
    c.launch_fee_lamports = 0;
    c.launch_tax_bps = 0;
    c.bump = ctx.bumps.config;
    Ok(())
}

// ---- set_fees (admin). Creates the config PDA on first call so a live
// platform that predates this account can still be configured. ----
#[derive(Accounts)]
pub struct SetFees<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(seeds = [PLATFORM_SEED], bump = platform.bump,
        constraint = platform.admin == admin.key() @ MagicPadError::Unauthorized)]
    pub platform: Box<Account<'info, Platform>>,

    #[account(init_if_needed, payer = admin, space = 8 + PlatformConfig::INIT_SPACE,
        seeds = [CONFIG_SEED], bump)]
    pub config: Box<Account<'info, PlatformConfig>>,

    pub system_program: Program<'info, System>,
}

pub fn set_fees_handler(
    ctx: Context<SetFees>,
    launch_fee_lamports: u64,
    launch_tax_bps: u16,
) -> Result<()> {
    require!(launch_tax_bps <= BPS_DENOM, MagicPadError::TaxTooHigh);
    let c = &mut ctx.accounts.config;
    c.launch_fee_lamports = launch_fee_lamports;
    c.launch_tax_bps = launch_tax_bps;
    c.bump = ctx.bumps.config;
    Ok(())
}

// ---- withdraw_platform (admin). amount = 0 sweeps everything above rent. ----
#[derive(Accounts)]
pub struct WithdrawPlatform<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(mut, seeds = [PLATFORM_SEED], bump = platform.bump,
        constraint = platform.admin == admin.key() @ MagicPadError::Unauthorized)]
    pub platform: Box<Account<'info, Platform>>,
}

pub fn withdraw_platform_handler(ctx: Context<WithdrawPlatform>, amount: u64) -> Result<()> {
    let ai = ctx.accounts.platform.to_account_info();
    let rent_min = Rent::get()?.minimum_balance(ai.data_len());
    let available = ai.lamports().saturating_sub(rent_min);
    let pay = if amount == 0 { available } else { amount };
    require!(pay > 0, MagicPadError::NothingToClaim);
    require!(pay <= available, MagicPadError::Overflow);
    **ai.try_borrow_mut_lamports()? -= pay;
    **ctx.accounts.admin.to_account_info().try_borrow_mut_lamports()? += pay;
    Ok(())
}

// ---- set_gate (admin). Arms the UI-only door: while gate.key is set,
// open_trade_session and top_up_session demand its co-signature, and the
// backend signs only for its own frontend. Pubkey::default() disarms —
// entry falls back to permissionless, the kill-switch. init_if_needed:
// the PDA is born on first arm, so a live platform upgrades with no
// migration and no ceremony. ----
#[derive(Accounts)]
pub struct SetGate<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(seeds = [PLATFORM_SEED], bump = platform.bump,
        constraint = platform.admin == admin.key() @ MagicPadError::Unauthorized)]
    pub platform: Box<Account<'info, Platform>>,

    #[account(init_if_needed, payer = admin, space = 8 + Gate::INIT_SPACE,
        seeds = [GATE_SEED], bump)]
    pub gate: Box<Account<'info, Gate>>,

    pub system_program: Program<'info, System>,
}

pub fn set_gate_handler(ctx: Context<SetGate>, new_key: Pubkey) -> Result<()> {
    let g = &mut ctx.accounts.gate;
    g.key = new_key;
    g.bump = ctx.bumps.gate;
    Ok(())
}
