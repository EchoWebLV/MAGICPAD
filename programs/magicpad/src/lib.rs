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
// 1 SOL to launch, zero fees to trade, and the whole bonding phase runs
// INSIDE a MagicBlock Ephemeral Rollup: one L1 approval escrows a bankroll
// and pins a throwaway session key, then every buy/sell is a gasless
// session-key transaction at rollup speed. The SPL mint exists from second
// zero but stays at zero supply until graduation — to every L1 indexer and
// snipe bot the token simply isn't there. When the crossing buy fills the
// curve the market freezes, state commits home, cash follows ledger
// (reconcile), traders mint their claims, losses pay 10% back from the
// rakeback pool, and the raised SOL + unsold supply leave to seed Meteora.
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

    pub fn fund_rakeback(ctx: Context<FundRakeback>, amount: u64) -> Result<()> {
        fund_rakeback_handler(ctx, amount)
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

    pub fn claim_rakeback(ctx: Context<ClaimRakeback>) -> Result<()> {
        claim_rakeback_handler(ctx)
    }

    pub fn graduate(ctx: Context<Graduate>) -> Result<()> {
        graduate_handler(ctx)
    }
}
