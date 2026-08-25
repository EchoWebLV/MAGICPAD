use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};
use ephemeral_rollups_sdk::anchor::delegate;
use ephemeral_rollups_sdk::cpi::DelegateConfig;

use crate::constants::*;
use crate::error::MagicPadError;
use crate::state::{Gate, Launch, TradeSession, LAUNCH_BONDING};

// The door check, shared by open_trade_session and top_up_session. The
// gate PDA is read as a raw snapshot (same idiom as the delegated launch
// reads below): absent or default-keyed = open entry; armed = the tx must
// carry the gate key's signature. Trading, reconcile and claims never
// pass through here — permissioned entry, trustless exit.
pub(crate) fn require_gate<'info>(
    gate: &UncheckedAccount<'info>,
    gate_signer: &UncheckedAccount<'info>,
) -> Result<()> {
    let data = gate.try_borrow_data()?;
    if data.is_empty() {
        return Ok(()); // never armed — the PDA was never created
    }
    let g = Gate::try_deserialize(&mut &data[..])?;
    if g.key == Pubkey::default() {
        return Ok(()); // disarmed
    }
    require!(gate_signer.is_signer, MagicPadError::GateRequired);
    require_keys_eq!(gate_signer.key(), g.key, MagicPadError::GateRequired);
    Ok(())
}

// ============================================================================
// The money rail, cloned from the stakehouse BetSession (devnet-proven):
// cash and ledger split lanes. The deposit lands in a session PDA on L1
// BEFORE the rollup ever sees the session — that escrow is the hard ceiling
// on everything the ER can ever do with this trader's SOL. Inside the ER
// the throwaway session key signs gasless buys/sells that only move ledger
// numbers; reconcile_trade_session moves the actual lamports afterward,
// gated by the committed ledger.
// ============================================================================

// ---- open_trade_session (L1, the trader). One approval covers the whole
// bonding phase: escrow the bankroll and pin the session key. The client
// bundles delegate_trade_session into the same tx — then zero popups. ----
#[derive(Accounts)]
#[instruction(launch_id: u64)]
pub struct OpenTradeSession<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

    #[account(init, payer = trader, space = 8 + TradeSession::INIT_SPACE,
        seeds = [SESSION_SEED, launch_id.to_le_bytes().as_ref(), trader.key().as_ref()], bump)]
    pub session: Box<Account<'info, TradeSession>>,

    /// CHECK: the launch PDA — owned by the DELEGATION program while it
    /// lives in the ER, so no Account<> owner check can pass here. Seeds
    /// pin the address; we hand-deserialize the L1 snapshot (data is
    /// preserved under delegation) just to gate on state.
    #[account(seeds = [LAUNCH_SEED, launch_id.to_le_bytes().as_ref()], bump)]
    pub launch: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,

    /// CHECK: the canonical gate PDA — seeds pin the address; may be empty
    /// (never armed), which require_gate treats as an open door.
    #[account(seeds = [GATE_SEED], bump)]
    pub gate: UncheckedAccount<'info>,

    /// CHECK: verified in require_gate — must be a tx signer matching
    /// gate.key while armed; any unsigned pubkey while the door is open.
    pub gate_signer: UncheckedAccount<'info>,
}

pub fn open_trade_session_handler(
    ctx: Context<OpenTradeSession>,
    launch_id: u64,
    session_key: Pubkey,
    deposit: u64,
) -> Result<()> {
    require_gate(&ctx.accounts.gate, &ctx.accounts.gate_signer)?;
    require!(deposit >= MIN_DEPOSIT, MagicPadError::DepositTooSmall);
    require!(
        session_key != Pubkey::default(),
        MagicPadError::SessionKeyMismatch
    );
    {
        // The L1 snapshot is pre-delegation state — enough: a launch never
        // returns to BONDING once it leaves, so this gate can only be stale
        // toward frozen, and every ER buy re-checks state live anyway.
        let data = ctx.accounts.launch.try_borrow_data()?;
        let l = Launch::try_deserialize(&mut &data[..])?;
        require!(l.id == launch_id, MagicPadError::WrongLaunch);
        require!(l.state == LAUNCH_BONDING, MagicPadError::LaunchNotBonding);
    }

    let s = &mut ctx.accounts.session;
    s.launch_id = launch_id;
    s.trader = ctx.accounts.trader.key();
    s.session_key = session_key;
    s.deposit = deposit;
    s.sol_spent = 0;
    s.sol_proceeds = 0;
    s.tokens_held = 0;
    s.cost_basis = 0;
    s.realized_loss = 0;
    s.reconciled = false;
    s.tokens_claimed = false;
    s.rakeback_claimed = false;
    s.bump = ctx.bumps.session;

    // The escrow: wallet → session PDA, on L1, before the ER ever sees it.
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.key(),
            Transfer {
                from: ctx.accounts.trader.to_account_info(),
                to: ctx.accounts.session.to_account_info(),
            },
        ),
        deposit,
    )?;
    Ok(())
}

// ---- rotate_session_key (ER, the trader). The session key is minted by
// whichever browser opened the session — a second browser (or a wiped
// localStorage) holds a different key and every trade bounces with
// SessionKeyMismatch. The wallet itself signs here, so the rightful trader
// can re-point the session at the key their current browser holds. Runs in
// the ER while the session is delegated (the wallet is just a read-only
// signer, fees are zero); no state gate — after settlement the key is
// meaningless anyway. ----
#[derive(Accounts)]
pub struct RotateSessionKey<'info> {
    /// the WALLET — the only party allowed to swap trade keys
    pub trader: Signer<'info>,

    #[account(mut,
        seeds = [SESSION_SEED, session.launch_id.to_le_bytes().as_ref(), session.trader.as_ref()],
        bump = session.bump,
        constraint = session.trader == trader.key() @ MagicPadError::Unauthorized)]
    pub session: Box<Account<'info, TradeSession>>,
}

pub fn rotate_session_key_handler(
    ctx: Context<RotateSessionKey>,
    new_key: Pubkey,
) -> Result<()> {
    require!(
        new_key != Pubkey::default(),
        MagicPadError::SessionKeyMismatch
    );
    ctx.accounts.session.session_key = new_key;
    Ok(())
}

// ---- delegate_trade_session (L1, the trader — bundled right after open).
// Payer-gated by construction: the seeds bind the PDA to the payer, so a
// stranger can't delegate someone else's session out from under them. ----
#[delegate]
#[derive(Accounts)]
#[instruction(launch_id: u64)]
pub struct DelegateTradeSession<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: delegated via the DLP CPI; Unchecked so Anchor doesn't
    /// re-serialize after ownership moves to the delegation program.
    #[account(mut, del,
        seeds = [SESSION_SEED, launch_id.to_le_bytes().as_ref(), payer.key().as_ref()], bump)]
    pub session: UncheckedAccount<'info>,
}

pub fn delegate_trade_session_handler(
    ctx: Context<DelegateTradeSession>,
    launch_id: u64,
) -> Result<()> {
    // pre-CPI sanity on the not-yet-delegated data
    {
        let data = ctx.accounts.session.try_borrow_data()?;
        let s = TradeSession::try_deserialize(&mut &data[..])?;
        require!(s.launch_id == launch_id, MagicPadError::WrongLaunch);
        require!(
            s.trader == ctx.accounts.payer.key(),
            MagicPadError::Unauthorized
        );
        require!(!s.reconciled, MagicPadError::AlreadyReconciled);
    }
    let payer_key = ctx.accounts.payer.key();
    ctx.accounts.delegate_session(
        &ctx.accounts.payer,
        &[SESSION_SEED, &launch_id.to_le_bytes(), payer_key.as_ref()],
        DelegateConfig {
            // pin the SAME validator the launch delegated to: a trade
            // touches launch + session atomically, one ER node for both
            validator: ctx.remaining_accounts.first().map(|a| a.key()),
            ..Default::default()
        },
    )?;
    Ok(())
}
