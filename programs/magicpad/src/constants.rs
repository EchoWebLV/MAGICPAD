pub const PLATFORM_SEED: &[u8] = b"platform";
pub const LAUNCH_SEED: &[u8] = b"launch";
pub const SESSION_SEED: &[u8] = b"tsession";
pub const TOPUP_SEED: &[u8] = b"topup";
pub const MINT_SEED: &[u8] = b"mint"; // PDA mint per launch — derivable, no keypair to pass
pub const POOL_SEED: &[u8] = b"pool"; // mint-seeded record of the Meteora DAMM v2 pool
pub const CONFIG_SEED: &[u8] = b"config"; // launch fee + graduation tax, admin-set
pub const GATE_SEED: &[u8] = b"gate"; // entry co-signer — armed = UI-only sessions

pub const TOKEN_DECIMALS: u8 = 6;
pub const TOKEN_TOTAL_SUPPLY: u64 = 1_000_000_000_000_000; // 1B tokens * 1e6
pub const CURVE_TOKEN_ALLOC: u64 = 793_100_000_000_000; // 79.31% sellable on curve (pump-style)
pub const VIRTUAL_SOL_INIT: u64 = 30_000_000_000; // 30 SOL virtual
pub const VIRTUAL_TOK_INIT: u64 = 1_073_000_000_000_000; // 1.073e15 (pump-style)
pub const GRADUATION_LAMPORTS: u64 = 85_000_000_000; // 85 SOL — curve alloc sells out at 85.005, pump-tuned
pub const MIN_DEPOSIT: u64 = 10_000_000; // 0.01 SOL
pub const BPS_DENOM: u16 = 10_000;

// Fairest mode: sells during bonding pay a tax that decays linearly with
// the position's (tokens-weighted) age, landing in the launch's flip pot
// and shipping to the Meteora seed at graduation. Flippers fund the pool.
pub const FLIP_TAX_START_BPS: u16 = 2_500; // 25% on an instant flip
pub const FLIP_DECAY_SECS: u64 = 1_800; // fades to zero over 30 minutes
