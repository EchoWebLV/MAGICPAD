use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

use crate::constants::*;
use crate::state::{Platform, RakebackPool};

// ============================================================================
// Platform bootstrap. One PDA holds admin + launch counter and receives the
// 1 SOL launch fees (lamports on the account — stakehouse pot pattern). The
// rakeback pool is born here too, empty: a segregated lamport bucket that
// only claim_rakeback drains. MVP funds it by hand (fund_rakeback); in v2
// the platform token's trading fees feed it.
// ============================================================================

#[derive(Accounts)]
pub struct InitPlatform<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(init, payer = admin, space = 8 + Platform::INIT_SPACE,
        seeds = [PLATFORM_SEED], bump)]
    pub platform: Box<Account<'info, Platform>>,

    #[account(init, payer = admin, space = 8 + RakebackPool::INIT_SPACE,
        seeds = [RAKEBACK_SEED], bump)]
    pub rakeback_pool: Box<Account<'info, RakebackPool>>,

    pub system_program: Program<'info, System>,
}

pub fn init_platform_handler(ctx: Context<InitPlatform>) -> Result<()> {
    let p = &mut ctx.accounts.platform;
    p.admin = ctx.accounts.admin.key();
    p.launch_seq = 0;
    p.bump = ctx.bumps.platform;
    Ok(())
}

// ---- fund_rakeback: permissionless top-up. Anyone may pay traders back. ----
#[derive(Accounts)]
pub struct FundRakeback<'info> {
    #[account(mut)]
    pub funder: Signer<'info>,

    #[account(mut, seeds = [RAKEBACK_SEED], bump)]
    pub rakeback_pool: Box<Account<'info, RakebackPool>>,

    pub system_program: Program<'info, System>,
}

pub fn fund_rakeback_handler(ctx: Context<FundRakeback>, amount: u64) -> Result<()> {
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.key(),
            Transfer {
                from: ctx.accounts.funder.to_account_info(),
                to: ctx.accounts.rakeback_pool.to_account_info(),
            },
        ),
        amount,
    )?;
    Ok(())
}
