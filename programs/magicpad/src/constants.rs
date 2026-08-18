pub const PLATFORM_SEED: &[u8] = b"platform";
pub const LAUNCH_SEED: &[u8] = b"launch";
pub const SESSION_SEED: &[u8] = b"tsession";
pub const RAKEBACK_SEED: &[u8] = b"rakeback";

pub const LAUNCH_FEE_LAMPORTS: u64 = 1_000_000_000; // 1 SOL, the pitch
pub const TOKEN_DECIMALS: u8 = 6;
pub const TOKEN_TOTAL_SUPPLY: u64 = 1_000_000_000_000_000; // 1B tokens * 1e6
pub const CURVE_TOKEN_ALLOC: u64 = 793_100_000_000_000; // 79.31% sellable on curve (pump-style)
pub const VIRTUAL_SOL_INIT: u64 = 30_000_000_000; // 30 SOL virtual
pub const VIRTUAL_TOK_INIT: u64 = 1_073_000_000_000_000; // 1.073e15 (pump-style)
pub const GRADUATION_LAMPORTS: u64 = 5_000_000_000; // 5 SOL on devnet MVP (mainnet: ~85)
pub const FIRST_WINDOW_SECS: i64 = 60;
pub const FIRST_WINDOW_MAX_BUY: u64 = 500_000_000; // 0.5 SOL per session in window
pub const RAKEBACK_BPS: u16 = 1_000; // 10% of realized losses
pub const MIN_DEPOSIT: u64 = 10_000_000; // 0.01 SOL
