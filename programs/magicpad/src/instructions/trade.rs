use anchor_lang::prelude::*;

use crate::constants::*;
use crate::curve;
use crate::error::MagicPadError;
use crate::state::{Launch, TradeSession, LAUNCH_BONDING, LAUNCH_FROZEN};

// ============================================================================
// The whole product lives in these two instructions. They run INSIDE the
// ephemeral rollup: the throwaway session key signs, the ER accepts a
// non-delegated fee payer (gasless — stakehouse precedent, devnet green),
// and nothing here moves a single lamport. The SOL is already escrowed on
// L1; buy/sell only mutate the ledger, and the curve state they mutate is
// invisible to every L1 indexer. Dark bonding, zero fees, zero popups.
// ============================================================================

#[derive(Accounts)]
pub struct TradeEr<'info> {
    /// NOT the wallet — the throwaway key open_trade_session pinned.
    pub session_signer: Signer<'info>,

    #[account(mut,
        seeds = [SESSION_SEED, session.launch_id.to_le_bytes().as_ref(), session.trader.as_ref()],
        bump = session.bump,
        constraint = session.session_key == session_signer.key() @ MagicPadError::SessionKeyMismatch)]
    pub session: Box<Account<'info, TradeSession>>,

    #[account(mut,
        seeds = [LAUNCH_SEED, launch.id.to_le_bytes().as_ref()], bump = launch.bump,
        constraint = launch.id == session.launch_id @ MagicPadError::WrongLaunch)]
    pub launch: Box<Account<'info, Launch>>,
}

pub fn buy_handler(ctx: Context<TradeEr>, amount_in: u64) -> Result<()> {
    let l = &mut ctx.accounts.launch;
    let s = &mut ctx.accounts.session;
    require!(l.state == LAUNCH_BONDING, MagicPadError::LaunchNotBonding);
    require!(amount_in > 0, MagicPadError::BadQuote);

    // Escrow discipline — THE invariant of the rail: net exposure can never
    // pass the L1 deposit, so reconciliation always covers this ledger in
    // full. saturating_sub because a net-winner's proceeds recycle.
    let exposure = s
        .sol_spent
        .checked_add(amount_in)
        .ok_or(MagicPadError::Overflow)?
        .saturating_sub(s.sol_proceeds);
    require!(exposure <= s.deposit, MagicPadError::ExceedsDeposit);

    // anti-snipe layer two: per-session gross-buy cap in the first window
    let now = Clock::get()?.unix_timestamp; // the ER mirrors the L1 clock
    if now < l.first_window_end_ts {
        let gross = s
            .sol_spent
            .checked_add(amount_in)
            .ok_or(MagicPadError::Overflow)?;
        require!(gross <= FIRST_WINDOW_MAX_BUY, MagicPadError::FirstWindowCap);
    }

    let out = curve::buy_quote(l.virtual_sol, l.virtual_tok, amount_in)
        .ok_or(MagicPadError::BadQuote)?;
    require!(out > 0, MagicPadError::BadQuote); // dust in, nothing out — reject
    let sold = l
        .tokens_sold
        .checked_add(out)
        .ok_or(MagicPadError::Overflow)?;
    require!(sold <= CURVE_TOKEN_ALLOC, MagicPadError::BadQuote);

    // First buy = this session starts counting toward settlement. The
    // counter lives HERE because the ER is the only lane where the launch
    // is writable — L1 open_trade_session can't touch a delegated launch.
    if s.sol_spent == 0 {
        l.sessions_opened = l
            .sessions_opened
            .checked_add(1)
            .ok_or(MagicPadError::Overflow)?;
    }

    l.virtual_sol = l
        .virtual_sol
        .checked_add(amount_in)
        .ok_or(MagicPadError::Overflow)?;
    l.virtual_tok = l
        .virtual_tok
        .checked_sub(out)
        .ok_or(MagicPadError::Overflow)?;
    l.real_sol_raised = l
        .real_sol_raised
        .checked_add(amount_in)
        .ok_or(MagicPadError::Overflow)?;
    l.tokens_sold = sold;

    s.sol_spent = s
        .sol_spent
        .checked_add(amount_in)
        .ok_or(MagicPadError::Overflow)?;
    s.tokens_held = s
        .tokens_held
        .checked_add(out)
        .ok_or(MagicPadError::Overflow)?;
    s.cost_basis = s
        .cost_basis
        .checked_add(amount_in)
        .ok_or(MagicPadError::Overflow)?;

    // The crossing buy freezes the market. Graduation is a state change,
    // not a race — no sniping the migration block.
    if l.real_sol_raised >= GRADUATION_LAMPORTS {
        l.state = LAUNCH_FROZEN;
    }
    Ok(())
}

pub fn sell_handler(ctx: Context<TradeEr>, tokens_in: u64) -> Result<()> {
    let l = &mut ctx.accounts.launch;
    let s = &mut ctx.accounts.session;
    require!(l.state == LAUNCH_BONDING, MagicPadError::LaunchNotBonding);
    require!(tokens_in > 0, MagicPadError::BadQuote);
    require!(
        tokens_in <= s.tokens_held,
        MagicPadError::InsufficientTokens
    );

    let out = curve::sell_quote(l.virtual_sol, l.virtual_tok, tokens_in)
        .ok_or(MagicPadError::BadQuote)?;
    require!(out > 0, MagicPadError::BadQuote); // burning tokens for zero is a footgun

    // avg-cost slice of the basis for the sold portion (u64×u64 fits u128;
    // tokens_held > 0 because tokens_in > 0 and tokens_in <= tokens_held)
    let basis_slice = u64::try_from(
        s.cost_basis as u128 * tokens_in as u128 / s.tokens_held as u128,
    )
    .map_err(|_| MagicPadError::Overflow)?;

    // the rakeback ledger: realized losses only — unfarmable by wash flow,
    // a round trip at flat price loses only the rounding dust
    if out < basis_slice {
        s.realized_loss = s
            .realized_loss
            .checked_add(basis_slice - out)
            .ok_or(MagicPadError::Overflow)?;
    }

    l.virtual_sol = l
        .virtual_sol
        .checked_sub(out)
        .ok_or(MagicPadError::Overflow)?;
    l.virtual_tok = l
        .virtual_tok
        .checked_add(tokens_in)
        .ok_or(MagicPadError::Overflow)?;
    // sells drain the curve — the graduation gauge and reconcile
    // conservation both stay honest to the lamport
    l.real_sol_raised = l
        .real_sol_raised
        .checked_sub(out)
        .ok_or(MagicPadError::Overflow)?;
    l.tokens_sold = l
        .tokens_sold
        .checked_sub(tokens_in)
        .ok_or(MagicPadError::Overflow)?;

    s.sol_proceeds = s
        .sol_proceeds
        .checked_add(out)
        .ok_or(MagicPadError::Overflow)?;
    s.tokens_held = s
        .tokens_held
        .checked_sub(tokens_in)
        .ok_or(MagicPadError::Overflow)?;
    s.cost_basis = s
        .cost_basis
        .checked_sub(basis_slice)
        .ok_or(MagicPadError::Overflow)?;
    Ok(())
}
