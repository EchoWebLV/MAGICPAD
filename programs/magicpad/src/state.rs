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
    pub first_window_end_ts: i64,
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

// Discriminator-only lamport bucket: the segregated rakeback pool. Losses
// are paid back from HERE, never from the curve — the two flows can't mix.
#[account]
#[derive(InitSpace)]
pub struct RakebackPool {}

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
    pub realized_loss: u64,  // lamports, accumulates on losing sells → rakeback
    pub reconciled: bool,
    pub tokens_claimed: bool,
    pub rakeback_claimed: bool,
    pub bump: u8,
}
