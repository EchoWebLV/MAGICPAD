//! Shared harness: PDAs, anchor ix encoding, borsh mirrors of program state.
#![allow(dead_code)]

use litesvm::LiteSVM;
use solana_address::Address;
use solana_clock::Clock;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

pub const SO_PATH: &str = "../target/deploy/magicpad.so";
pub const LAMPORTS_PER_SOL: u64 = 1_000_000_000;

// program constants mirrored (keep in sync with constants.rs)
pub const TOKEN_TOTAL_SUPPLY: u64 = 1_000_000_000_000_000;
pub const CURVE_TOKEN_ALLOC: u64 = 793_100_000_000_000;
pub const VIRTUAL_SOL_INIT: u64 = 30_000_000_000;
pub const VIRTUAL_TOK_INIT: u64 = 1_073_000_000_000_000;
pub const GRADUATION_LAMPORTS: u64 = 5_000_000_000;
pub const FIRST_WINDOW_SECS: i64 = 60; // leftover Launch field; not enforced
pub const MIN_DEPOSIT: u64 = 10_000_000;

// launch states
pub const BONDING: u8 = 0;
pub const FROZEN: u8 = 1;
pub const RECONCILED: u8 = 2;
pub const GRADUATED: u8 = 3;

// error indexes (append-only in error.rs; raw asserts on purpose)
pub const E_LAUNCH_NOT_BONDING: u32 = 0;
pub const E_LAUNCH_NOT_FROZEN: u32 = 1;
pub const E_DEPOSIT_TOO_SMALL: u32 = 2;
pub const E_EXCEEDS_DEPOSIT: u32 = 3;
pub const E_INSUFFICIENT_TOKENS: u32 = 4;
pub const E_FIRST_WINDOW_CAP: u32 = 5;
pub const E_NOT_GRADUATABLE: u32 = 6;
pub const E_ALREADY_RECONCILED: u32 = 7;
pub const E_NOT_RECONCILED: u32 = 8;
pub const E_ALREADY_CLAIMED: u32 = 9;
pub const E_SESSION_KEY_MISMATCH: u32 = 10;
pub const E_BAD_QUOTE: u32 = 11;
pub const E_NOTHING_TO_CLAIM: u32 = 12;
pub const E_OVERFLOW: u32 = 13;
pub const E_BAD_METADATA: u32 = 14;
pub const E_UNAUTHORIZED: u32 = 15;
pub const E_WRONG_LAUNCH: u32 = 16;
pub const E_POT_NOT_READY: u32 = 17;
pub const E_ALREADY_APPLIED: u32 = 18;
pub const E_MINT_NOT_READY: u32 = 19;
pub const E_ALREADY_LOCKED: u32 = 20;
pub const E_BAD_POOL: u32 = 21;
pub const E_TAX_TOO_HIGH: u32 = 22;

pub fn program_id() -> Address {
    "27HH4WUhKMmkza5NTpAjwhHkRwiPotPw55HxvjDRDsws".parse().unwrap()
}
pub fn system_id() -> Address {
    "11111111111111111111111111111111".parse().unwrap()
}
pub fn token_program_id() -> Address {
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA".parse().unwrap()
}
pub fn ata_program_id() -> Address {
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL".parse().unwrap()
}

pub fn platform_pda() -> Address {
    Address::find_program_address(&[b"platform"], &program_id()).0
}
pub fn config_pda() -> Address {
    Address::find_program_address(&[b"config"], &program_id()).0
}
pub fn launch_pda(id: u64) -> Address {
    Address::find_program_address(&[b"launch", &id.to_le_bytes()], &program_id()).0
}
pub fn mint_pda(id: u64) -> Address {
    Address::find_program_address(&[b"mint", &id.to_le_bytes()], &program_id()).0
}
pub fn pool_pda(mint: &Address) -> Address {
    Address::find_program_address(&[b"pool", mint.as_ref()], &program_id()).0
}
pub fn session_pda(launch_id: u64, trader: &Address) -> Address {
    Address::find_program_address(
        &[b"tsession", &launch_id.to_le_bytes(), trader.as_ref()],
        &program_id(),
    )
    .0
}
pub fn topup_pda(launch_id: u64, trader: &Address, nonce: u64) -> Address {
    Address::find_program_address(
        &[b"topup", &launch_id.to_le_bytes(), trader.as_ref(), &nonce.to_le_bytes()],
        &program_id(),
    )
    .0
}
pub fn ata_address(owner: &Address, mint: &Address) -> Address {
    Address::find_program_address(
        &[owner.as_ref(), token_program_id().as_ref(), mint.as_ref()],
        &ata_program_id(),
    )
    .0
}

/// anchor ix data = sha256("global:<name>")[0..8] ++ borsh(args)
pub fn ix_data(name: &str, args: &impl borsh::BorshSerialize) -> Vec<u8> {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(format!("global:{name}").as_bytes());
    let mut data = digest[..8].to_vec();
    args.serialize(&mut data).unwrap();
    data
}
pub fn ix_data_empty(name: &str) -> Vec<u8> {
    use sha2::{Digest, Sha256};
    Sha256::digest(format!("global:{name}").as_bytes())[..8].to_vec()
}

pub fn fresh_svm() -> LiteSVM {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(program_id(), SO_PATH).unwrap();
    svm
}

pub fn send(
    svm: &mut LiteSVM,
    payer: &Keypair,
    extra_signers: &[&Keypair],
    ixs: &[Instruction],
) -> Result<litesvm::types::TransactionMetadata, litesvm::types::FailedTransactionMetadata> {
    svm.expire_blockhash();
    let msg = Message::new(ixs, Some(&payer.pubkey()));
    let mut signers: Vec<&Keypair> = vec![payer];
    signers.extend_from_slice(extra_signers);
    let tx = Transaction::new(&signers, msg, svm.latest_blockhash());
    svm.send_transaction(tx)
}

/// assert a tx failed with a specific custom (MagicPadError) code.
pub fn assert_pad_error<T: std::fmt::Debug>(
    res: Result<T, litesvm::types::FailedTransactionMetadata>,
    variant: u32,
    what: &str,
) {
    let err = res.expect_err(&format!("{what}: expected failure"));
    let s = format!("{:?}", err.err);
    let code = 6000 + variant;
    assert!(
        s.contains(&format!("Custom({code})")) || s.contains(&format!("custom program error: {code}")),
        "{what}: expected MagicPadError {variant} (custom {code}), got {s}"
    );
}

pub fn warp_to(svm: &mut LiteSVM, unix_ts: i64) {
    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp = unix_ts;
    svm.set_sysvar(&clock);
}

pub fn now(svm: &LiteSVM) -> i64 {
    let clock: Clock = svm.get_sysvar();
    clock.unix_timestamp
}

// ---------- curve mirror (exact copy of curve.rs math) ----------

pub fn buy_quote(virtual_sol: u64, virtual_tok: u64, sol_in: u64) -> u64 {
    if sol_in == 0 {
        return 0;
    }
    let vs = virtual_sol as u128;
    let vt = virtual_tok as u128;
    let k = vs * vt;
    let new_vs = vs + sol_in as u128;
    let new_vt = k / new_vs + 1;
    u64::try_from(vt - new_vt).unwrap()
}

pub fn sell_quote(virtual_sol: u64, virtual_tok: u64, tok_in: u64) -> u64 {
    if tok_in == 0 {
        return 0;
    }
    let vs = virtual_sol as u128;
    let vt = virtual_tok as u128;
    let k = vs * vt;
    let new_vt = vt + tok_in as u128;
    let new_vs = k / new_vt + 1;
    u64::try_from(vs - new_vs).unwrap()
}

// ---------- instruction builders (account order = the Accounts structs) ----------

pub fn init_platform_ix(admin: &Address) -> Instruction {
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(*admin, true),
            AccountMeta::new(platform_pda(), false),
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(system_id(), false),
        ],
        data: ix_data_empty("init_platform"),
    }
}

#[derive(borsh::BorshSerialize)]
pub struct SetFeesArgs {
    pub launch_fee_lamports: u64,
    pub launch_tax_bps: u16,
}

pub fn set_fees_ix(admin: &Address, launch_fee_lamports: u64, launch_tax_bps: u16) -> Instruction {
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(*admin, true),
            AccountMeta::new_readonly(platform_pda(), false),
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(system_id(), false),
        ],
        data: ix_data("set_fees", &SetFeesArgs { launch_fee_lamports, launch_tax_bps }),
    }
}

pub fn withdraw_platform_ix(admin: &Address, amount: u64) -> Instruction {
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(*admin, true),
            AccountMeta::new(platform_pda(), false),
        ],
        data: ix_data("withdraw_platform", &amount),
    }
}

#[derive(borsh::BorshSerialize)]
pub struct CreateLaunchArgs {
    pub name: String,
    pub symbol: String,
}

pub fn create_launch_ix(creator: &Address, id: u64, name: &str, symbol: &str) -> Instruction {
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(*creator, true),
            AccountMeta::new(platform_pda(), false),
            AccountMeta::new_readonly(config_pda(), false),
            AccountMeta::new(launch_pda(id), false),
            AccountMeta::new(mint_pda(id), false),
            AccountMeta::new_readonly(token_program_id(), false),
            AccountMeta::new_readonly(system_id(), false),
        ],
        data: ix_data(
            "create_launch",
            &CreateLaunchArgs { name: name.into(), symbol: symbol.into() },
        ),
    }
}

#[derive(borsh::BorshSerialize)]
pub struct OpenTradeSessionArgs {
    pub launch_id: u64,
    pub session_key: [u8; 32],
    pub deposit: u64,
}

pub fn open_trade_session_ix(
    trader: &Address,
    launch_id: u64,
    session_key: &Address,
    deposit: u64,
) -> Instruction {
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(*trader, true),
            AccountMeta::new(session_pda(launch_id, trader), false),
            AccountMeta::new_readonly(launch_pda(launch_id), false),
            AccountMeta::new_readonly(system_id(), false),
            AccountMeta::new_readonly(gate_pda(), false),
            // unsigned placeholder — enough while the gate is disarmed
            AccountMeta::new_readonly(*trader, false),
        ],
        data: ix_data(
            "open_trade_session",
            &OpenTradeSessionArgs {
                launch_id,
                session_key: session_key.to_bytes(),
                deposit,
            },
        ),
    }
}

/// the in-ER trade. In litesvm it runs as a plain program ix (no delegation
/// transport) — same ledger logic. The SESSION KEY signs, never the wallet.
pub fn buy_ix(session_key: &Address, trader: &Address, launch_id: u64, amount_in: u64) -> Instruction {
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(*session_key, true),
            AccountMeta::new(session_pda(launch_id, trader), false),
            AccountMeta::new(launch_pda(launch_id), false),
        ],
        data: ix_data("buy", &amount_in),
    }
}

pub fn sell_ix(session_key: &Address, trader: &Address, launch_id: u64, tokens_in: u64) -> Instruction {
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(*session_key, true),
            AccountMeta::new(session_pda(launch_id, trader), false),
            AccountMeta::new(launch_pda(launch_id), false),
        ],
        data: ix_data("sell", &tokens_in),
    }
}

/// the WALLET signs — not the session key. `signer` and `owner` split so
/// tests can point a stranger's signature at someone else's session.
pub fn rotate_session_key_ix(
    signer: &Address,
    owner: &Address,
    launch_id: u64,
    new_key: &Address,
) -> Instruction {
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(*signer, true),
            AccountMeta::new(session_pda(launch_id, owner), false),
        ],
        data: ix_data("rotate_session_key", &new_key.to_bytes()),
    }
}

#[derive(borsh::BorshSerialize)]
pub struct TopUpSessionArgs {
    pub launch_id: u64,
    pub nonce: u64,
    pub amount: u64,
}

pub fn top_up_session_ix(
    trader: &Address,
    launch_id: u64,
    nonce: u64,
    amount: u64,
) -> Instruction {
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(*trader, true),
            AccountMeta::new_readonly(session_pda(launch_id, trader), false),
            AccountMeta::new_readonly(launch_pda(launch_id), false),
            AccountMeta::new(topup_pda(launch_id, trader, nonce), false),
            AccountMeta::new_readonly(system_id(), false),
            AccountMeta::new_readonly(gate_pda(), false),
            // unsigned placeholder — enough while the gate is disarmed
            AccountMeta::new_readonly(*trader, false),
        ],
        data: ix_data("top_up_session", &TopUpSessionArgs { launch_id, nonce, amount }),
    }
}

/// the in-ER consume. In litesvm it runs as a plain program ix — the
/// SESSION KEY signs, the deposit ceiling grows by the note's amount.
pub fn apply_top_up_ix(
    session_key: &Address,
    trader: &Address,
    launch_id: u64,
    nonce: u64,
) -> Instruction {
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(*session_key, true),
            AccountMeta::new(session_pda(launch_id, trader), false),
            AccountMeta::new_readonly(launch_pda(launch_id), false),
            AccountMeta::new(topup_pda(launch_id, trader, nonce), false),
        ],
        data: ix_data("apply_top_up", &nonce),
    }
}

/// permissionless crank, trader not a signer — mirrors reconcile.
pub fn absorb_top_up_ix(trader: &Address, launch_id: u64, nonce: u64) -> Instruction {
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(*trader, false),
            AccountMeta::new(session_pda(launch_id, trader), false),
            AccountMeta::new(topup_pda(launch_id, trader, nonce), false),
        ],
        data: ix_data_empty("absorb_top_up"),
    }
}

pub fn freeze_launch_ix(admin: &Address, launch_id: u64) -> Instruction {
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(*admin, true),
            AccountMeta::new_readonly(platform_pda(), false),
            AccountMeta::new(launch_pda(launch_id), false),
        ],
        data: ix_data_empty("freeze_launch"),
    }
}

/// permissionless crank: the TRADER is not a signer — anyone pays the fee,
/// every payout is pinned to the recorded trader either way.
pub fn reconcile_ix(trader: &Address, launch_id: u64) -> Instruction {
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(*trader, false),
            AccountMeta::new(launch_pda(launch_id), false),
            AccountMeta::new(session_pda(launch_id, trader), false),
        ],
        data: ix_data_empty("reconcile_trade_session"),
    }
}

pub fn claim_tokens_ix(cranker: &Address, trader: &Address, launch_id: u64) -> Instruction {
    let mint = mint_pda(launch_id);
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(*cranker, true),
            AccountMeta::new_readonly(*trader, false),
            AccountMeta::new_readonly(platform_pda(), false),
            AccountMeta::new_readonly(launch_pda(launch_id), false),
            AccountMeta::new(session_pda(launch_id, trader), false),
            AccountMeta::new(mint, false),
            AccountMeta::new(ata_address(trader, &mint), false),
            AccountMeta::new_readonly(token_program_id(), false),
            AccountMeta::new_readonly(ata_program_id(), false),
            AccountMeta::new_readonly(system_id(), false),
        ],
        data: ix_data_empty("claim_tokens"),
    }
}

pub fn graduate_ix(admin: &Address, launch_id: u64) -> Instruction {
    let mint = mint_pda(launch_id);
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(*admin, true),
            AccountMeta::new(platform_pda(), false),
            AccountMeta::new_readonly(config_pda(), false),
            AccountMeta::new(launch_pda(launch_id), false),
            AccountMeta::new(mint, false),
            AccountMeta::new(ata_address(admin, &mint), false),
            AccountMeta::new_readonly(token_program_id(), false),
            AccountMeta::new_readonly(ata_program_id(), false),
            AccountMeta::new_readonly(system_id(), false),
        ],
        data: ix_data_empty("graduate"),
    }
}

pub fn lock_mint_ix(launch_id: u64) -> Instruction {
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(platform_pda(), false),
            AccountMeta::new_readonly(launch_pda(launch_id), false),
            AccountMeta::new(mint_pda(launch_id), false),
            AccountMeta::new_readonly(token_program_id(), false),
        ],
        data: ix_data_empty("lock_mint"),
    }
}

pub fn record_pool_ix(admin: &Address, launch_id: u64, pool: &Address) -> Instruction {
    let mint = mint_pda(launch_id);
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(*admin, true),
            AccountMeta::new_readonly(platform_pda(), false),
            AccountMeta::new_readonly(launch_pda(launch_id), false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new(pool_pda(&mint), false),
            AccountMeta::new_readonly(system_id(), false),
        ],
        data: ix_data("record_pool", &pool.to_bytes()),
    }
}

// ---------- borsh mirrors (skip the 8-byte discriminator) ----------

#[derive(borsh::BorshDeserialize, Debug)]
pub struct PlatformMirror {
    pub admin: [u8; 32],
    pub launch_seq: u64,
    pub bump: u8,
}

#[derive(borsh::BorshDeserialize, Debug)]
pub struct ConfigMirror {
    pub launch_fee_lamports: u64,
    pub launch_tax_bps: u16,
    pub bump: u8,
}

#[derive(borsh::BorshDeserialize, Debug)]
pub struct LaunchMirror {
    pub id: u64,
    pub creator: [u8; 32],
    pub mint: [u8; 32],
    pub name: String,
    pub symbol: String,
    pub created_ts: i64,
    pub first_window_end_ts: i64,
    pub state: u8,
    pub virtual_sol: u64,
    pub virtual_tok: u64,
    pub real_sol_raised: u64,
    pub tokens_sold: u64,
    pub sessions_reconciled: u64,
    pub sessions_opened: u64,
    pub bump: u8,
}

#[derive(borsh::BorshDeserialize, Debug)]
pub struct MigratedPoolMirror {
    pub launch_id: u64,
    pub mint: [u8; 32],
    pub pool: [u8; 32],
    pub bump: u8,
}

#[derive(borsh::BorshDeserialize, Debug)]
pub struct SessionMirror {
    pub launch_id: u64,
    pub trader: [u8; 32],
    pub session_key: [u8; 32],
    pub deposit: u64,
    pub sol_spent: u64,
    pub sol_proceeds: u64,
    pub tokens_held: u64,
    pub cost_basis: u64,
    pub realized_loss: u64,
    pub reconciled: bool,
    pub tokens_claimed: bool,
    pub rakeback_claimed: bool,
    pub bump: u8,
}

#[derive(borsh::BorshDeserialize, Debug)]
pub struct TopUpMirror {
    pub launch_id: u64,
    pub trader: [u8; 32],
    pub nonce: u64,
    pub amount: u64,
    pub applied: bool,
    pub bump: u8,
}

pub fn read_account<T: borsh::BorshDeserialize>(svm: &LiteSVM, addr: &Address) -> T {
    let acc = svm.get_account(addr).expect("account exists");
    // deserialize the PREFIX only: anchor pads String fields to max_len,
    // so the account is longer than the borsh encoding of its live data
    let mut slice: &[u8] = &acc.data[8..];
    T::deserialize(&mut slice).expect("borsh decode")
}

pub fn read_launch(svm: &LiteSVM, id: u64) -> LaunchMirror {
    read_account(svm, &launch_pda(id))
}

pub fn read_session(svm: &LiteSVM, launch_id: u64, trader: &Address) -> SessionMirror {
    read_account(svm, &session_pda(launch_id, trader))
}

pub fn lamports(svm: &LiteSVM, addr: &Address) -> u64 {
    svm.get_account(addr).map(|a| a.lamports).unwrap_or(0)
}

pub fn token_amount(svm: &LiteSVM, addr: &Address) -> u64 {
    let d = svm.get_account(addr).unwrap().data;
    u64::from_le_bytes(d[64..72].try_into().unwrap())
}

pub fn mint_supply(svm: &LiteSVM, mint: &Address) -> u64 {
    let d = svm.get_account(mint).unwrap().data;
    u64::from_le_bytes(d[36..44].try_into().unwrap())
}

pub fn mint_decimals(svm: &LiteSVM, mint: &Address) -> u8 {
    svm.get_account(mint).unwrap().data[44]
}

pub fn mint_authority(svm: &LiteSVM, mint: &Address) -> Address {
    let d = svm.get_account(mint).unwrap().data;
    Address::try_from(&d[4..36]).unwrap()
}

pub fn mint_authority_opt(svm: &LiteSVM, mint: &Address) -> Option<Address> {
    let d = svm.get_account(mint).unwrap().data;
    let tag = u32::from_le_bytes(d[0..4].try_into().unwrap());
    if tag == 0 { None } else { Some(Address::try_from(&d[4..36]).unwrap()) }
}

/// The standard table: platform inited, launch 0 created by `creator`,
/// funded traders alice + bob with session keys, one fee-paying cranker.
pub struct Table {
    pub admin: Keypair,
    pub creator: Keypair,
    pub alice: Keypair,
    pub bob: Keypair,
    pub ka: Keypair, // alice's session key
    pub kb: Keypair, // bob's session key
    pub cranker: Keypair,
}

pub fn setup_table(svm: &mut LiteSVM) -> Table {
    let t = Table {
        admin: Keypair::new(),
        creator: Keypair::new(),
        alice: Keypair::new(),
        bob: Keypair::new(),
        ka: Keypair::new(),
        kb: Keypair::new(),
        cranker: Keypair::new(),
    };
    for k in [&t.admin, &t.creator, &t.alice, &t.bob, &t.cranker] {
        svm.airdrop(&k.pubkey(), 100 * LAMPORTS_PER_SOL).unwrap();
    }
    send(svm, &t.admin, &[], &[init_platform_ix(&t.admin.pubkey())]).unwrap();
    send(svm, &t.creator, &[], &[create_launch_ix(&t.creator.pubkey(), 0, "DARKPAD", "DARK")])
        .unwrap();
    t
}

/// clock jump kept so older tests stay stable; buys no longer need it
pub fn warp_past_window(svm: &mut LiteSVM) {
    let l = read_launch(svm, 0);
    warp_to(svm, l.first_window_end_ts + 1);
}

// ---------- the entry gate (UI-only door) ----------

pub const E_GATE_REQUIRED: u32 = 23;

pub fn gate_pda() -> Address {
    Address::find_program_address(&[b"gate"], &program_id()).0
}

/// admin arms (or disarms, with Address::default()) the entry gate.
pub fn set_gate_ix(admin: &Address, new_key: &Address) -> Instruction {
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(*admin, true),
            AccountMeta::new_readonly(platform_pda(), false),
            AccountMeta::new(gate_pda(), false),
            AccountMeta::new_readonly(system_id(), false),
        ],
        data: ix_data("set_gate", &new_key.to_bytes()),
    }
}

/// open with the platform gate co-signing — the only door once armed.
pub fn open_trade_session_gated_ix(
    trader: &Address,
    launch_id: u64,
    session_key: &Address,
    deposit: u64,
    gate_signer: &Address,
) -> Instruction {
    let mut ix = open_trade_session_ix(trader, launch_id, session_key, deposit);
    let n = ix.accounts.len();
    ix.accounts[n - 1] = AccountMeta::new_readonly(*gate_signer, true);
    ix
}

pub fn top_up_session_gated_ix(
    trader: &Address,
    launch_id: u64,
    nonce: u64,
    amount: u64,
    gate_signer: &Address,
) -> Instruction {
    let mut ix = top_up_session_ix(trader, launch_id, nonce, amount);
    let n = ix.accounts.len();
    ix.accounts[n - 1] = AccountMeta::new_readonly(*gate_signer, true);
    ix
}

#[derive(borsh::BorshDeserialize, Debug)]
pub struct GateMirror {
    pub key: [u8; 32],
    pub bump: u8,
}
