//! pump.fun mode. The PumpLaunch PDA is the switch; the four instructions
//! here are enable (creator, before any trade), set_pump_mint (admin, once
//! the CLI created the pump token), pump_claim (per session — the vault buys
//! the trader's share on pump.fun) and pump_graduate (the remainder is burnt
//! through a buy, residue to the platform, Mooner mint revoked).
use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::MagicPadError;
use crate::pump_cpi;
use crate::state::{Launch, Platform, PumpLaunch, LAUNCH_BONDING, LAUNCH_FROZEN, LAUNCH_RECONCILED};

#[derive(Accounts)]
#[instruction(launch_id: u64)]
pub struct EnablePump<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    /// `Account<>` on purpose: the owner check IS the "before delegate_launch"
    /// guard. Once delegated the launch is DLP-owned and this instruction is
    /// permanently unreachable (no undelegate path while BONDING), so the
    /// create tx must bundle enable_pump ahead of delegate_launch.
    #[account(
        seeds = [LAUNCH_SEED, launch_id.to_le_bytes().as_ref()],
        bump = launch.bump,
        constraint = launch.creator == creator.key() @ MagicPadError::Unauthorized,
    )]
    pub launch: Box<Account<'info, Launch>>,
    #[account(
        init,
        payer = creator,
        space = 8 + PumpLaunch::INIT_SPACE,
        seeds = [PUMP_SEED, launch_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub pump: Box<Account<'info, PumpLaunch>>,
    pub system_program: Program<'info, System>,
}

pub fn enable_pump_handler(ctx: Context<EnablePump>, launch_id: u64) -> Result<()> {
    let l = &ctx.accounts.launch;
    // the 1 SOL line only makes sense for a market nobody has priced yet
    require!(
        l.state == LAUNCH_BONDING && l.real_sol_raised == 0 && l.tokens_sold == 0,
        MagicPadError::PumpTooLate
    );
    let p = &mut ctx.accounts.pump;
    p.launch_id = launch_id;
    p.pump_mint = Pubkey::default();
    p.claims_done = 0;
    p.bump = ctx.bumps.pump;
    Ok(())
}

#[derive(Accounts)]
pub struct SetPumpMint<'info> {
    pub admin: Signer<'info>,
    #[account(
        seeds = [PLATFORM_SEED],
        bump = platform.bump,
        constraint = platform.admin == admin.key() @ MagicPadError::Unauthorized,
    )]
    pub platform: Box<Account<'info, Platform>>,
    #[account(seeds = [LAUNCH_SEED, launch.id.to_le_bytes().as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, Launch>>,
    #[account(
        mut,
        seeds = [PUMP_SEED, launch.id.to_le_bytes().as_ref()],
        bump = pump.bump,
        constraint = pump.launch_id == launch.id @ MagicPadError::WrongLaunch,
    )]
    pub pump: Box<Account<'info, PumpLaunch>>,
    /// CHECK: the pump.fun mint; only its key is recorded, the curve proves it
    pub pump_mint: UncheckedAccount<'info>,
    /// CHECK: pump's BondingCurve for pump_mint — owner + derivation checked here, creator/complete in the handler
    #[account(
        owner = pump_cpi::PUMP_PROGRAM @ MagicPadError::BadPumpAccount,
        address = pump_cpi::bonding_curve(&pump_mint.key()) @ MagicPadError::BadPumpAccount,
    )]
    pub pump_bonding_curve: UncheckedAccount<'info>,
}

pub fn set_pump_mint_handler(ctx: Context<SetPumpMint>) -> Result<()> {
    let l = &ctx.accounts.launch;
    require!(
        l.state == LAUNCH_FROZEN || l.state == LAUNCH_RECONCILED,
        MagicPadError::LaunchNotFrozen
    );
    let p = &mut ctx.accounts.pump;
    require!(p.pump_mint == Pubkey::default(), MagicPadError::PumpMintAlreadySet);
    let head = pump_cpi::parse_bonding_curve(&ctx.accounts.pump_bonding_curve.try_borrow_data()?)
        .ok_or(MagicPadError::BadPumpAccount)?;
    // the pump token must be OURS (creator = launch creator) and still on its curve
    require!(head.creator == l.creator && !head.complete, MagicPadError::BadPumpAccount);
    p.pump_mint = ctx.accounts.pump_mint.key();
    Ok(())
}
