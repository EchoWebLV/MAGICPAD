use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Platform {
    pub admin: Pubkey,
    pub launch_seq: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Launch {
    pub id: u64,
    pub creator: Pubkey,
    pub mint: Pubkey,
    #[max_len(32)]
    pub name: String,
    #[max_len(10)]
    pub symbol: String,
    pub created_ts: i64,
    pub first_window_end_ts: i64, // leftover layout — no longer enforced
    pub state: u8,            // 0 BONDING, 1 FROZEN, 2 RECONCILED, 3 GRADUATED
    pub virtual_sol: u64,     // virtual reserve, starts VIRTUAL_SOL_INIT
    pub virtual_tok: u64,     // virtual reserve, starts VIRTUAL_TOK_INIT
    pub real_sol_raised: u64, // net ledger SOL into curve (graduation gauge)
    pub tokens_sold: u64,     // net ledger tokens out (claims outstanding)
    pub sessions_reconciled: u64,
    pub sessions_opened: u64,
    pub bump: u8,
}

pub const LAUNCH_BONDING: u8 = 0;
pub const LAUNCH_FROZEN: u8 = 1;
pub const LAUNCH_RECONCILED: u8 = 2;
pub const LAUNCH_GRADUATED: u8 = 3;

// Mint-seeded pointer at the DAMM v2 pool. Launch layout stays untouched so
// live bonding accounts keep deserializing after this upgrade. Anyone with
// the CA can derive this PDA — the swap API never needs launch id.
#[account]
#[derive(InitSpace)]
pub struct MigratedPool {
    pub launch_id: u64,
    pub mint: Pubkey,
    pub pool: Pubkey,
    pub bump: u8,
}

// Admin-set fee schedule. Separate PDA so the live Platform account does
// not have to realloc. Default after init is 0/0 (free launches, no tax).
#[account]
#[derive(InitSpace)]
pub struct PlatformConfig {
    pub launch_fee_lamports: u64,
    pub launch_tax_bps: u16, // of real_sol_raised at graduate, paid to platform
    pub bump: u8,
}

// A top-up in flight: lamports escrowed on L1 in this note, then the note
// delegates and the ER consumes it (deposit += amount, applied = true).
// At settle, absorb merges applied notes into the session PDA — reconcile's
// lamports >= rent + deposit check refuses to run until they all land —
// and refunds unapplied ones in full. Nonce-seeded: any number in flight.
#[account]
#[derive(InitSpace)]
pub struct TopUp {
    pub launch_id: u64,
    pub trader: Pubkey,
    pub nonce: u64,
    pub amount: u64,   // lamports escrowed in this PDA on L1
    pub applied: bool, // flipped inside the ER when the deposit grew
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct TradeSession {
    pub launch_id: u64,
    pub trader: Pubkey,      // the real wallet, payout target — pinned at open
    pub session_key: Pubkey, // throwaway ER signer
    pub deposit: u64,        // lamports escrowed in this PDA on L1
    pub sol_spent: u64,      // ledger: gross SOL into curve (invariant: net <= deposit)
    pub sol_proceeds: u64,   // ledger: gross SOL back from sells
    pub tokens_held: u64,    // ledger claim, becomes SPL at claim_tokens
    pub cost_basis: u64,     // lamports basis of tokens_held (avg cost)
    pub realized_loss: u64,  // avg-cost loss ledger (rakeback retired; field stays for layout)
    pub reconciled: bool,
    pub tokens_claimed: bool,
    pub rakeback_claimed: bool, // leftover of the old claim flag — never written true now
    pub bump: u8,
}

// The entry gate. While `key` is a real pubkey, open_trade_session and
// top_up_session demand that key's signature on the tx — the platform
// backend co-signs only for requests born in its own UI, so side wallets
// and custom bots have no door into a curve. Pubkey::default() (or this
// PDA not existing yet) = open entry, the pre-gate behavior. Trading,
// reconcile and claims never touch this: permissioned entry, trustless
// exit.
#[account]
#[derive(InitSpace)]
pub struct Gate {
    pub key: Pubkey,
    pub bump: u8,
}
