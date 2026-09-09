//! pump.fun mode. The PumpLaunch PDA is the switch; the four instructions
//! here are enable (creator, before any trade), set_pump_mint (admin, once
//! the CLI created the pump token), pump_claim (per session — the vault buys
//! the trader's share on pump.fun) and pump_graduate (the remainder is burnt
//! through a buy, residue to the platform, Mooner mint revoked).
use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::MagicPadError;
use crate::state::{Launch, PumpLaunch, LAUNCH_BONDING};

#[derive(Accounts)]
#[instruction(launch_id: u64)]
pub struct EnablePump<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        seeds = [LAUNCH_SEED, launch_id.to_le_bytes().as_ref()],
        bump = launch.bump,
        constraint = launch.creator == creator.key() @ MagicPadError::Unauthorized,
    )]
    pub launch: Account<'info, Launch>,
    #[account(
        init,
        payer = creator,
        space = 8 + PumpLaunch::INIT_SPACE,
        seeds = [PUMP_SEED, launch_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub pump: Account<'info, PumpLaunch>,
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
