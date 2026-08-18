use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::commit;
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};

use crate::constants::*;
use crate::error::MagicPadError;
use crate::state::{Launch, Platform, LAUNCH_BONDING, LAUNCH_FROZEN};

// ============================================================================
// ER lifecycle — bringing a finished market home. The crossing buy already
// set FROZEN inside the rollup; these instructions flush the state back to
// L1 so reconcile can move real lamports. Both commits are permissionless
// but FROZEN-gated: nobody can yank a live market out of the ER, anyone
// can push a dead one home. freeze_launch is the admin escape hatch — a
// market that fizzles still settles, every deposit still walks home.
// ============================================================================

// ---- freeze_launch (ER, admin). Manual freeze: janitor path for launches
// that will never graduate. Platform is never delegated — the ER clones
// undelegated accounts read-only (stakehouse reads house the same way). ----
#[derive(Accounts)]
pub struct FreezeLaunch<'info> {
    pub admin: Signer<'info>,

    #[account(seeds = [PLATFORM_SEED], bump = platform.bump,
        constraint = platform.admin == admin.key() @ MagicPadError::Unauthorized)]
    pub platform: Box<Account<'info, Platform>>,

    #[account(mut, seeds = [LAUNCH_SEED, launch.id.to_le_bytes().as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, Launch>>,
}

pub fn freeze_launch_handler(ctx: Context<FreezeLaunch>) -> Result<()> {
    let l = &mut ctx.accounts.launch;
    require!(l.state == LAUNCH_BONDING, MagicPadError::LaunchNotBonding);
    l.state = LAUNCH_FROZEN;
    Ok(())
}

// ---- commit_launch (ER, permissionless). Commit AND undelegate, so the
// L1 reconcile/graduate lane can mutate the launch again. ----
#[commit]
#[derive(Accounts)]
pub struct CommitLaunch<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut, seeds = [LAUNCH_SEED, launch.id.to_le_bytes().as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, Launch>>,
}

pub fn commit_launch_handler(ctx: Context<CommitLaunch>) -> Result<()> {
    // FROZEN-gate: a stranger cannot halt a live market by committing it
    require!(
        ctx.accounts.launch.state >= LAUNCH_FROZEN,
        MagicPadError::LaunchNotFrozen
    );
    MagicIntentBundleBuilder::new(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(&[ctx.accounts.launch.to_account_info()])
    .build_and_invoke()?;
    Ok(())
}

// ---- commit_trade_sessions (ER, permissionless). remaining_accounts =
// session PDAs, batches of 8 (tx size). Run BEFORE commit_launch so the
// launch is still readable here for the FROZEN gate. ----
#[commit]
#[derive(Accounts)]
pub struct CommitTradeSessions<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(seeds = [LAUNCH_SEED, launch.id.to_le_bytes().as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, Launch>>,
}

pub fn commit_trade_sessions_handler<'info>(
    ctx: Context<'info, CommitTradeSessions<'info>>,
) -> Result<()> {
    require!(
        ctx.accounts.launch.state >= LAUNCH_FROZEN,
        MagicPadError::LaunchNotFrozen
    );
    if ctx.remaining_accounts.is_empty() {
        return Ok(()); // an empty crank is a no-op, not an error
    }
    MagicIntentBundleBuilder::new(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(ctx.remaining_accounts)
    .build_and_invoke()?;
    Ok(())
}
