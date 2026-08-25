use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::ephemeral;

pub mod constants;
pub mod curve;
pub mod error;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("27HH4WUhKMmkza5NTpAjwhHkRwiPotPw55HxvjDRDsws");

// ============================================================================
// MAGICPAD — the dark-bonding launchpad.
//
// Launch fee and graduation tax live on a config PDA (default 0 / 0 — free
// launches). The bonding phase runs INSIDE a MagicBlock Ephemeral Rollup:
// one L1 approval escrows a bankroll and pins a throwaway session key, then
// every buy/sell is a gasless session-key transaction at rollup speed. The
// SPL mint exists from second zero but stays at zero supply until
// graduation. When the crossing buy fills the curve the market freezes,
// state commits home, cash follows ledger (reconcile), traders mint their
// claims, and the raised SOL + unsold supply leave to seed Meteora.
// Dark bonding, loud graduation.
// ============================================================================

// #[ephemeral] injects `process_undelegation` — the callback the delegation
// program invokes on L1 to hand a committed account back to us. Without it,
// undelegation dies with InstructionFallbackNotFound(101).
#[ephemeral]
#[program]
pub mod magicpad {
    use super::*;

    // -- platform --
    pub fn init_platform(ctx: Context<InitPlatform>) -> Result<()> {
        init_platform_handler(ctx)
    }

    pub fn set_fees(
        ctx: Context<SetFees>,
        launch_fee_lamports: u64,
        launch_tax_bps: u16,
    ) -> Result<()> {
        set_fees_handler(ctx, launch_fee_lamports, launch_tax_bps)
    }

    pub fn withdraw_platform(ctx: Context<WithdrawPlatform>, amount: u64) -> Result<()> {
        withdraw_platform_handler(ctx, amount)
    }

    /// Arm (or disarm, with Pubkey::default()) the entry gate: while armed,
    /// opening or topping up a trade session requires this key's co-signature.
    pub fn set_gate(ctx: Context<SetGate>, new_key: Pubkey) -> Result<()> {
        set_gate_handler(ctx, new_key)
    }

    // -- launch lifecycle (L1) --
    pub fn create_launch(ctx: Context<CreateLaunch>, name: String, symbol: String) -> Result<()> {
        create_launch_handler(ctx, name, symbol)
    }

    pub fn delegate_launch(ctx: Context<DelegateLaunch>, launch_id: u64) -> Result<()> {
        delegate_launch_handler(ctx, launch_id)
    }

    // -- trader sessions (L1) --
    pub fn open_trade_session(
        ctx: Context<OpenTradeSession>,
        launch_id: u64,
        session_key: Pubkey,
        deposit: u64,
    ) -> Result<()> {
        open_trade_session_handler(ctx, launch_id, session_key, deposit)
    }

    pub fn delegate_trade_session(
        ctx: Context<DelegateTradeSession>,
        launch_id: u64,
    ) -> Result<()> {
        delegate_trade_session_handler(ctx, launch_id)
    }

    // -- escrow top-ups: the ceiling that grows mid-session --
    pub fn rotate_session_key(ctx: Context<RotateSessionKey>, new_key: Pubkey) -> Result<()> {
        instructions::session::rotate_session_key_handler(ctx, new_key)
    }

    pub fn top_up_session(
        ctx: Context<TopUpSession>,
        launch_id: u64,
        nonce: u64,
        amount: u64,
    ) -> Result<()> {
        top_up_session_handler(ctx, launch_id, nonce, amount)
    }

    pub fn delegate_top_up(ctx: Context<DelegateTopUp>, launch_id: u64, nonce: u64) -> Result<()> {
        delegate_top_up_handler(ctx, launch_id, nonce)
    }

    pub fn apply_top_up(ctx: Context<ApplyTopUp>, nonce: u64) -> Result<()> {
        apply_top_up_handler(ctx, nonce)
    }

    pub fn absorb_top_up(ctx: Context<AbsorbTopUp>) -> Result<()> {
        absorb_top_up_handler(ctx)
    }

    // -- the curve (ER, gasless, ledger-only) --
    pub fn buy(ctx: Context<TradeEr>, amount_in: u64) -> Result<()> {
        buy_handler(ctx, amount_in)
    }

    pub fn sell(ctx: Context<TradeEr>, tokens_in: u64) -> Result<()> {
        sell_handler(ctx, tokens_in)
    }

    // -- ER lifecycle --
    pub fn freeze_launch(ctx: Context<FreezeLaunch>) -> Result<()> {
        freeze_launch_handler(ctx)
    }

    pub fn commit_launch(ctx: Context<CommitLaunch>) -> Result<()> {
        commit_launch_handler(ctx)
    }

    pub fn commit_trade_sessions<'info>(
        ctx: Context<'info, CommitTradeSessions<'info>>,
    ) -> Result<()> {
        commit_trade_sessions_handler(ctx)
    }

    // -- the L1 landing --
    pub fn reconcile_trade_session(ctx: Context<ReconcileTradeSession>) -> Result<()> {
        reconcile_trade_session_handler(ctx)
    }

    pub fn claim_tokens(ctx: Context<ClaimTokens>) -> Result<()> {
        claim_tokens_handler(ctx)
    }

    pub fn graduate(ctx: Context<Graduate>) -> Result<()> {
        graduate_handler(ctx)
    }

    pub fn lock_mint(ctx: Context<LockMint>) -> Result<()> {
        lock_mint_handler(ctx)
    }

    pub fn record_pool(ctx: Context<RecordPool>, pool: Pubkey) -> Result<()> {
        record_pool_handler(ctx, pool)
    }
}
