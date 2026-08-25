use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};
use ephemeral_rollups_sdk::anchor::delegate;
use ephemeral_rollups_sdk::cpi::DelegateConfig;

use crate::constants::*;
use crate::error::MagicPadError;
use crate::state::{Launch, TopUp, TradeSession, LAUNCH_BONDING};

// ============================================================================
// Escrow that grows mid-session. The deposit field lives inside the ER and
// the lamports live in the session PDA — neither is reachable directly once
// the session delegates, so a top-up travels the same road the deposit did:
// escrow lamports on L1 first (in a nonce-seeded note), delegate the note,
// then the ER consumes it and the ceiling moves. At settle the note comes
// home with the sessions (commit_trade_sessions takes any delegated PDA)
// and absorb folds it into the session PDA — reconcile's own
// lamports >= rent + deposit check refuses to fire until every applied
// note has landed, so the ordering can't be gotten wrong. A note the ER
// never consumed (market froze first, delegate never landed) refunds the
// trader in full, rent included.
// ============================================================================

// ---- top_up_session (L1, the trader). The client bundles delegate_top_up
// into the same tx, then apply_top_up on the ER — one signature, and the
// next buy clears. ----
#[derive(Accounts)]
#[instruction(launch_id: u64, nonce: u64)]
pub struct TopUpSession<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

    /// CHECK: the session PDA — DLP-owned while delegated, so no typed
    /// check can pass. Seeds pin the address; the L1 snapshot (data is
    /// preserved under delegation) proves it exists and belongs to the
    /// signer before any lamports move.
    #[account(seeds = [SESSION_SEED, launch_id.to_le_bytes().as_ref(), trader.key().as_ref()], bump)]
    pub session: UncheckedAccount<'info>,

    /// CHECK: the launch PDA — same DLP-ownership story. The snapshot can
    /// only be stale toward FROZEN; worst case the note escrows, the ER
    /// refuses it, and absorb refunds every lamport.
    #[account(seeds = [LAUNCH_SEED, launch_id.to_le_bytes().as_ref()], bump)]
    pub launch: UncheckedAccount<'info>,

    #[account(init, payer = trader, space = 8 + TopUp::INIT_SPACE,
        seeds = [TOPUP_SEED, launch_id.to_le_bytes().as_ref(), trader.key().as_ref(), nonce.to_le_bytes().as_ref()],
        bump)]
    pub note: Box<Account<'info, TopUp>>,

    pub system_program: Program<'info, System>,

    /// CHECK: the canonical gate PDA — seeds pin the address; may be empty
    /// (never armed), which require_gate treats as an open door.
    #[account(seeds = [GATE_SEED], bump)]
    pub gate: UncheckedAccount<'info>,

    /// CHECK: verified in require_gate — must be a tx signer matching
    /// gate.key while armed; any unsigned pubkey while the door is open.
    pub gate_signer: UncheckedAccount<'info>,
}

pub fn top_up_session_handler(
    ctx: Context<TopUpSession>,
    launch_id: u64,
    nonce: u64,
    amount: u64,
) -> Result<()> {
    super::session::require_gate(&ctx.accounts.gate, &ctx.accounts.gate_signer)?;
    require!(amount >= MIN_DEPOSIT, MagicPadError::DepositTooSmall);
    {
        let data = ctx.accounts.session.try_borrow_data()?;
        let s = TradeSession::try_deserialize(&mut &data[..])?;
        require!(s.launch_id == launch_id, MagicPadError::WrongLaunch);
        require!(
            s.trader == ctx.accounts.trader.key(),
            MagicPadError::Unauthorized
        );
        require!(!s.reconciled, MagicPadError::AlreadyReconciled);
    }
    {
        let data = ctx.accounts.launch.try_borrow_data()?;
        let l = Launch::try_deserialize(&mut &data[..])?;
        require!(l.id == launch_id, MagicPadError::WrongLaunch);
        require!(l.state == LAUNCH_BONDING, MagicPadError::LaunchNotBonding);
    }

    let n = &mut ctx.accounts.note;
    n.launch_id = launch_id;
    n.trader = ctx.accounts.trader.key();
    n.nonce = nonce;
    n.amount = amount;
    n.applied = false;
    n.bump = ctx.bumps.note;

    // the escrow: wallet → note PDA, on L1, before the ER ever sees it
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.key(),
            Transfer {
                from: ctx.accounts.trader.to_account_info(),
                to: ctx.accounts.note.to_account_info(),
            },
        ),
        amount,
    )?;
    Ok(())
}

// ---- delegate_top_up (L1, the trader — bundled right after top_up).
// Seeds bind the note to the payer, so nobody delegates a stranger's. ----
#[delegate]
#[derive(Accounts)]
#[instruction(launch_id: u64, nonce: u64)]
pub struct DelegateTopUp<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: delegated via the DLP CPI; Unchecked so Anchor doesn't
    /// re-serialize after ownership moves to the delegation program.
    #[account(mut, del,
        seeds = [TOPUP_SEED, launch_id.to_le_bytes().as_ref(), payer.key().as_ref(), nonce.to_le_bytes().as_ref()],
        bump)]
    pub note: UncheckedAccount<'info>,
}

pub fn delegate_top_up_handler(
    ctx: Context<DelegateTopUp>,
    launch_id: u64,
    nonce: u64,
) -> Result<()> {
    // pre-CPI sanity on the not-yet-delegated data
    {
        let data = ctx.accounts.note.try_borrow_data()?;
        let n = TopUp::try_deserialize(&mut &data[..])?;
        require!(n.launch_id == launch_id, MagicPadError::WrongLaunch);
        require!(!n.applied, MagicPadError::AlreadyApplied);
    }
    let payer_key = ctx.accounts.payer.key();
    ctx.accounts.delegate_note(
        &ctx.accounts.payer,
        &[
            TOPUP_SEED,
            &launch_id.to_le_bytes(),
            payer_key.as_ref(),
            &nonce.to_le_bytes(),
        ],
        DelegateConfig {
            // same validator as the launch and session — one ER node
            validator: ctx.remaining_accounts.first().map(|a| a.key()),
            ..Default::default()
        },
    )?;
    Ok(())
}

// ---- apply_top_up (ER, the session key). The ceiling moves: the note is
// consumed and the escrow the buys check against grows by its amount. Only
// while BONDING — after freeze the deposit bump could never be used, so
// the note stays unapplied and absorb refunds it instead. ----
#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct ApplyTopUp<'info> {
    /// NOT the wallet — the throwaway key open_trade_session pinned.
    pub session_signer: Signer<'info>,

    #[account(mut,
        seeds = [SESSION_SEED, session.launch_id.to_le_bytes().as_ref(), session.trader.as_ref()],
        bump = session.bump,
        constraint = session.session_key == session_signer.key() @ MagicPadError::SessionKeyMismatch)]
    pub session: Box<Account<'info, TradeSession>>,

    #[account(
        seeds = [LAUNCH_SEED, launch.id.to_le_bytes().as_ref()], bump = launch.bump,
        constraint = launch.id == session.launch_id @ MagicPadError::WrongLaunch)]
    pub launch: Box<Account<'info, Launch>>,

    // seeds derive from the SESSION's own launch_id + trader: the note is
    // bound to this exact session, no cross-trader application possible
    #[account(mut,
        seeds = [TOPUP_SEED, session.launch_id.to_le_bytes().as_ref(), session.trader.as_ref(), nonce.to_le_bytes().as_ref()],
        bump = note.bump)]
    pub note: Box<Account<'info, TopUp>>,
}

pub fn apply_top_up_handler(ctx: Context<ApplyTopUp>, _nonce: u64) -> Result<()> {
    require!(
        ctx.accounts.launch.state == LAUNCH_BONDING,
        MagicPadError::LaunchNotBonding
    );
    require!(!ctx.accounts.note.applied, MagicPadError::AlreadyApplied);

    let s = &mut ctx.accounts.session;
    s.deposit = s
        .deposit
        .checked_add(ctx.accounts.note.amount)
        .ok_or(MagicPadError::Overflow)?;
    ctx.accounts.note.applied = true;
    Ok(())
}

// ---- absorb_top_up (L1, permissionless crank). Typed accounts double as
// the undelegation gate, exactly like reconcile. Applied: the escrowed
// amount folds into the session PDA so reconcile's payout is fully funded;
// unapplied: it never counted toward the ledger, refund in full. Either
// way the note closes and its rent goes home to the trader. ----
#[derive(Accounts)]
pub struct AbsorbTopUp<'info> {
    /// CHECK: refund + rent target — pinned to the note's recorded trader.
    #[account(mut, constraint = trader.key() == note.trader @ MagicPadError::Unauthorized)]
    pub trader: UncheckedAccount<'info>,

    #[account(mut,
        seeds = [SESSION_SEED, note.launch_id.to_le_bytes().as_ref(), note.trader.as_ref()],
        bump = session.bump)]
    pub session: Box<Account<'info, TradeSession>>,

    #[account(mut, close = trader,
        seeds = [TOPUP_SEED, note.launch_id.to_le_bytes().as_ref(), note.trader.as_ref(), note.nonce.to_le_bytes().as_ref()],
        bump = note.bump)]
    pub note: Box<Account<'info, TopUp>>,
}

pub fn absorb_top_up_handler(ctx: Context<AbsorbTopUp>) -> Result<()> {
    if ctx.accounts.note.applied {
        // the ledger already counts this amount inside session.deposit —
        // the lamports follow it; close (post-handler) sends rent home
        let amount = ctx.accounts.note.amount;
        let note_ai = ctx.accounts.note.to_account_info();
        let session_ai = ctx.accounts.session.to_account_info();
        **note_ai.try_borrow_mut_lamports()? -= amount;
        **session_ai.try_borrow_mut_lamports()? += amount;
    }
    // unapplied: nothing to move — close refunds amount + rent to the trader
    Ok(())
}
