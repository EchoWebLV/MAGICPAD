//! pump.fun under litesvm: mainnet ELFs + accounts captured by
//! scripts/dump-pump-fixtures.mjs into ../fixtures (gitignored). Every
//! pump-dependent test calls `load_pump` and returns early on None.
//! Set PUMP_FIXTURES_REQUIRED (any value) to make a missing capture fail
//! instead of skip; use it in the pre-merge command.
use std::fs;
use std::path::{Path, PathBuf};

use litesvm::LiteSVM;
use solana_account::Account;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;

use super::{
    ata_address, ata_program_id, ix_data, launch_pda, mint_pda, platform_pda, program_id, pump_pda,
    session_pda, system_id, token_program_id, warp_to, LAMPORTS_PER_SOL,
};

pub fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures")
}

// ---- pump.fun ids and PDAs (seeds verified against mainnet in pump_spike.rs) ----
pub fn pump_id() -> Address {
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P".parse().unwrap()
}
pub fn pfee_id() -> Address {
    "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ".parse().unwrap()
}
pub fn global_pda() -> Address {
    Address::find_program_address(&[b"global"], &pump_id()).0
}
pub fn event_authority() -> Address {
    Address::find_program_address(&[b"__event_authority"], &pump_id()).0
}
pub fn gva_pda() -> Address {
    Address::find_program_address(&[b"global_volume_accumulator"], &pump_id()).0
}
pub fn fee_config_pda() -> Address {
    Address::find_program_address(&[b"fee_config", pump_id().as_ref()], &pfee_id()).0
}
pub fn bonding_curve_pda(mint: &Address) -> Address {
    Address::find_program_address(&[b"bonding-curve", mint.as_ref()], &pump_id()).0
}
pub fn bonding_curve_v2_pda(mint: &Address) -> Address {
    Address::find_program_address(&[b"bonding-curve-v2", mint.as_ref()], &pump_id()).0
}
pub fn creator_vault_pda(creator: &Address) -> Address {
    Address::find_program_address(&[b"creator-vault", creator.as_ref()], &pump_id()).0
}
pub fn uva_pda(user: &Address) -> Address {
    Address::find_program_address(&[b"user_volume_accumulator", user.as_ref()], &pump_id()).0
}

// ---- our program's pump-side PDAs ----
pub fn pump_vault_pda(launch_id: u64, trader: &Address) -> Address {
    Address::find_program_address(
        &[b"pumpvault", &launch_id.to_le_bytes(), trader.as_ref()],
        &program_id(),
    )
    .0
}
pub fn pump_launch_vault_pda(launch_id: u64) -> Address {
    Address::find_program_address(&[b"pumpvault", &launch_id.to_le_bytes()], &program_id()).0
}

pub struct PumpFixtures {
    pub captured_at: i64,
    pub fee_recipient: Address,
    pub buyback: Address,
    pub mint: Address,
    pub creator: Keypair,
    pub bonding_curve: Address,
    pub associated_bonding_curve: Address,
}

impl PumpFixtures {
    /// a second handle on the creator keypair (Keypair is not Clone)
    pub fn creator_keypair(&self) -> Keypair {
        Keypair::try_from(&self.creator.to_bytes()[..]).unwrap()
    }
}

fn read_bytes(path: &Path) -> Vec<u8> {
    fs::read(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// .acct = owner(32) ‖ lamports u64 LE ‖ data
fn read_acct(path: &Path) -> Account {
    let b = read_bytes(path);
    assert!(b.len() >= 40, "{}: {} bytes, need owner(32)+lamports(8)", path.display(), b.len());
    Account {
        lamports: u64::from_le_bytes(b[32..40].try_into().unwrap()),
        data: b[40..].to_vec(),
        owner: Address::try_from(&b[..32]).unwrap(),
        executable: false,
        rent_epoch: 0,
    }
}

/// solana-cli style JSON array of 64 bytes, parsed by hand (no serde here)
fn read_keypair(path: &Path) -> Keypair {
    let text = fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let bytes: Vec<u8> = text
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .split(',')
        .map(|s| {
            s.trim()
                .parse::<u8>()
                .unwrap_or_else(|e| panic!("{}: bad keypair byte {s:?}: {e}", path.display()))
        })
        .collect();
    assert_eq!(bytes.len(), 64, "{}: expected 64 bytes", path.display());
    Keypair::try_from(&bytes[..]).unwrap()
}

/// Loads pump + pfee and the captured accounts into `svm`, funds the fee
/// wallets, and warps the clock to capture time. None when the fixtures are
/// absent (the notice only shows under --nocapture; set PUMP_FIXTURES_REQUIRED
/// to fail instead) — callers `return` and the test counts as passed.
pub fn load_pump(svm: &mut LiteSVM) -> Option<PumpFixtures> {
    let dir = fixtures_dir();
    let meta_path = dir.join("meta.txt");
    if !meta_path.exists() {
        eprintln!(
            "pump fixtures missing at {} — run `node scripts/dump-pump-fixtures.mjs` (mainnet RPC); skipping",
            dir.display()
        );
        if std::env::var_os("PUMP_FIXTURES_REQUIRED").is_some() {
            panic!("PUMP_FIXTURES_REQUIRED is set and {} is missing", meta_path.display());
        }
        return None;
    }
    let meta = fs::read_to_string(&meta_path)
        .unwrap_or_else(|e| panic!("{}: {e}", meta_path.display()));
    let get = |key: &str| -> String {
        meta.lines()
            .find_map(|l| l.strip_prefix(&format!("{key}=")))
            .unwrap_or_else(|| panic!("meta.txt lacks {key}"))
            .trim()
            .to_string()
    };

    svm.add_program(pump_id(), &read_bytes(&dir.join("pump.so"))).unwrap();
    svm.add_program(pfee_id(), &read_bytes(&dir.join("pfee.so"))).unwrap();
    for (file, addr) in [
        ("global.acct", global_pda()),
        ("fee_config.acct", fee_config_pda()),
        ("gva.acct", gva_pda()),
    ] {
        svm.set_account(addr, read_acct(&dir.join(file))).unwrap();
    }

    let mint: Address = get("mint").parse().unwrap_or_else(|e| panic!("meta.txt mint: {e:?}"));
    let bonding_curve = bonding_curve_pda(&mint);
    let associated_bonding_curve = ata_address(&bonding_curve, &mint);
    svm.set_account(mint, read_acct(&dir.join("mint.acct"))).unwrap();
    svm.set_account(bonding_curve, read_acct(&dir.join("bonding_curve.acct"))).unwrap();
    svm.set_account(associated_bonding_curve, read_acct(&dir.join("associated_bonding_curve.acct")))
        .unwrap();

    let fee_recipient: Address = get("fee_recipient")
        .parse()
        .unwrap_or_else(|e| panic!("meta.txt fee_recipient: {e:?}"));
    let buyback: Address = get("buyback_fee_recipient")
        .parse()
        .unwrap_or_else(|e| panic!("meta.txt buyback_fee_recipient: {e:?}"));
    // pump transfers fees into these; they must exist rent-exempt
    svm.airdrop(&fee_recipient, LAMPORTS_PER_SOL).unwrap();
    svm.airdrop(&buyback, LAMPORTS_PER_SOL).unwrap();

    let captured_at: i64 = get("captured_at")
        .parse()
        .unwrap_or_else(|e| panic!("meta.txt captured_at: {e:?}"));
    // Overwrites the clock: call load_pump BEFORE any other warp_to. Keeps
    // timestamps at capture time (litesvm boots at unix 0). Not load-bearing
    // for this capture — without it the buy still passes — because this
    // capture's volume-accumulator window is 0..=0 (start_time, end_time and
    // seconds_in_a_day in gva.acct are all 0); kept so a capture that does
    // carry a real window still replays at the time it was taken.
    warp_to(svm, captured_at);

    let creator = read_keypair(&dir.join("creator-keypair.json"));
    assert_eq!(creator.pubkey().to_string(), get("creator"), "meta.txt creator != creator-keypair.json");

    Some(PumpFixtures {
        captured_at,
        fee_recipient,
        buyback,
        mint,
        creator,
        bonding_curve,
        associated_bonding_curve,
    })
}

/// setup_table, but the launch creator IS the fixture creator so pump's
/// bonding curve (creator = fixture creator) matches launch.creator.
pub fn setup_pump_table(svm: &mut LiteSVM, px: &PumpFixtures) -> super::Table {
    super::setup_table_with_creator(svm, px.creator_keypair())
}

/// pump.fun bonding curve, raw offsets (spec: BondingCurve layout). The IDL
/// names the reserves *_quote_reserves; on a SOL-quoted curve they are SOL.
/// Bytes 81.. (is_mayhem_mode, is_cashback_coin, quote_mint) are not read.
#[derive(Debug, Clone, Copy)]
pub struct BondingCurveView {
    pub virtual_token_reserves: u64,
    pub virtual_sol_reserves: u64,
    pub real_token_reserves: u64,
    pub real_sol_reserves: u64,
    pub token_total_supply: u64,
    pub complete: bool,
    pub creator: Address,
}

pub fn read_bonding_curve(svm: &LiteSVM, mint: &Address) -> BondingCurveView {
    let d = svm.get_account(&bonding_curve_pda(mint)).expect("bonding curve").data;
    const DISC: [u8; 8] = [23, 183, 248, 55, 96, 216, 172, 96];
    assert_eq!(&d[..8], &DISC, "not a pump BondingCurve account");
    let u = |at: usize| u64::from_le_bytes(d[at..at + 8].try_into().unwrap());
    BondingCurveView {
        virtual_token_reserves: u(8),
        virtual_sol_reserves: u(16),
        real_token_reserves: u(24),
        real_sol_reserves: u(32),
        token_total_supply: u(40),
        complete: d[48] != 0,
        creator: Address::try_from(&d[49..81]).unwrap(),
    }
}

/// SPL associated-token `CreateIdempotent` (data = [1])
pub fn create_ata_idempotent_ix(payer: &Address, owner: &Address, mint: &Address) -> Instruction {
    Instruction {
        program_id: ata_program_id(),
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(ata_address(owner, mint), false),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(system_id(), false),
            AccountMeta::new_readonly(token_program_id(), false),
        ],
        data: vec![1],
    }
}

/// The 18-account pump.fun `buy`. `user` pays and signs; tokens land in
/// `ata_owner`'s ATA (pump does not require ata_owner == user).
pub fn pump_buy_ix(
    user: &Address,
    mint: &Address,
    creator: &Address,
    ata_owner: &Address,
    amount: u64,
    max_sol_cost: u64,
    fee_recipient: &Address,
    buyback: &Address,
) -> Instruction {
    let bc = bonding_curve_pda(mint);
    let mut data = vec![102u8, 6, 61, 18, 1, 218, 235, 234];
    data.extend_from_slice(&amount.to_le_bytes());
    data.extend_from_slice(&max_sol_cost.to_le_bytes());
    data.push(1); // track_volume: pump's OptionBool is a one-byte newtype, not a two-byte Option<bool>
    Instruction {
        program_id: pump_id(),
        accounts: vec![
            AccountMeta::new_readonly(global_pda(), false),           // 0
            AccountMeta::new(*fee_recipient, false),                  // 1
            AccountMeta::new_readonly(*mint, false),                  // 2
            AccountMeta::new(bc, false),                              // 3
            AccountMeta::new(ata_address(&bc, mint), false),          // 4
            AccountMeta::new(ata_address(ata_owner, mint), false),    // 5
            AccountMeta::new(*user, true),                            // 6
            AccountMeta::new_readonly(system_id(), false),            // 7
            AccountMeta::new_readonly(token_program_id(), false),     // 8
            AccountMeta::new(creator_vault_pda(creator), false),      // 9
            AccountMeta::new_readonly(event_authority(), false),      // 10
            AccountMeta::new_readonly(pump_id(), false),              // 11
            AccountMeta::new_readonly(gva_pda(), false),              // 12
            AccountMeta::new(uva_pda(user), false),                   // 13
            AccountMeta::new_readonly(fee_config_pda(), false),       // 14
            AccountMeta::new_readonly(pfee_id(), false),              // 15
            AccountMeta::new_readonly(bonding_curve_v2_pda(mint), false), // 16
            AccountMeta::new(*buyback, false),                        // 17
        ],
        data,
    }
}

/// pump.fun `close_user_volume_accumulator` — rent back to `user`
pub fn close_uva_ix(user: &Address) -> Instruction {
    Instruction {
        program_id: pump_id(),
        accounts: vec![
            AccountMeta::new(*user, true),
            AccountMeta::new(uva_pda(user), false),
            AccountMeta::new_readonly(event_authority(), false),
            AccountMeta::new_readonly(pump_id(), false),
        ],
        data: vec![249, 69, 164, 218, 150, 103, 84, 138],
    }
}

// ---- our instructions that carry the pump account set ----
pub struct PumpKeys {
    pub mint: Address,
    pub creator: Address,
    pub fee_recipient: Address,
    pub buyback: Address,
}

impl From<&PumpFixtures> for PumpKeys {
    fn from(px: &PumpFixtures) -> PumpKeys {
        PumpKeys {
            mint: px.mint,
            creator: px.creator.pubkey(),
            fee_recipient: px.fee_recipient,
            buyback: px.buyback,
        }
    }
}

#[derive(borsh::BorshSerialize)]
pub struct PumpAmountArgs {
    pub amount: u64,
    pub max_sol_cost: u64,
}

/// the 13 pump-side accounts shared by pump_claim and pump_graduate, in struct order
fn pump_side_metas(pk: &PumpKeys, user: &Address) -> Vec<AccountMeta> {
    let bc = bonding_curve_pda(&pk.mint);
    vec![
        AccountMeta::new_readonly(global_pda(), false),
        AccountMeta::new(pk.fee_recipient, false),
        AccountMeta::new(bc, false),
        AccountMeta::new(ata_address(&bc, &pk.mint), false),
        AccountMeta::new(creator_vault_pda(&pk.creator), false),
        AccountMeta::new_readonly(event_authority(), false),
        AccountMeta::new_readonly(pump_id(), false),
        AccountMeta::new_readonly(gva_pda(), false),
        AccountMeta::new(uva_pda(user), false),
        AccountMeta::new_readonly(fee_config_pda(), false),
        AccountMeta::new_readonly(pfee_id(), false),
        AccountMeta::new_readonly(bonding_curve_v2_pda(&pk.mint), false),
        AccountMeta::new(pk.buyback, false),
    ]
}

pub fn pump_claim_ix(
    cranker: &Address,
    trader: &Address,
    launch_id: u64,
    pk: &PumpKeys,
    amount: u64,
    max_sol_cost: u64,
) -> Instruction {
    let vault = pump_vault_pda(launch_id, trader);
    let mut accounts = vec![
        AccountMeta::new(*cranker, true),
        AccountMeta::new_readonly(*trader, false),
        AccountMeta::new(launch_pda(launch_id), false),
        AccountMeta::new(pump_pda(launch_id), false),
        AccountMeta::new(session_pda(launch_id, trader), false),
        AccountMeta::new(vault, false),
        AccountMeta::new_readonly(pk.mint, false),
        AccountMeta::new(ata_address(trader, &pk.mint), false),
    ];
    accounts.extend(pump_side_metas(pk, &vault));
    accounts.extend([
        AccountMeta::new_readonly(token_program_id(), false),
        AccountMeta::new_readonly(ata_program_id(), false),
        AccountMeta::new_readonly(system_id(), false),
    ]);
    Instruction {
        program_id: program_id(),
        accounts,
        data: ix_data("pump_claim", &PumpAmountArgs { amount, max_sol_cost }),
    }
}

pub fn pump_graduate_ix(
    admin: &Address,
    launch_id: u64,
    pk: &PumpKeys,
    amount: u64,
    max_sol_cost: u64,
) -> Instruction {
    let vault = pump_launch_vault_pda(launch_id);
    let mut accounts = vec![
        AccountMeta::new(*admin, true),
        AccountMeta::new(platform_pda(), false),
        AccountMeta::new(launch_pda(launch_id), false),
        AccountMeta::new(pump_pda(launch_id), false),
        AccountMeta::new(mint_pda(launch_id), false),
        AccountMeta::new(vault, false),
        AccountMeta::new(ata_address(&vault, &pk.mint), false),
        AccountMeta::new(pk.mint, false),
    ];
    accounts.extend(pump_side_metas(pk, &vault));
    accounts.extend([
        AccountMeta::new_readonly(token_program_id(), false),
        AccountMeta::new_readonly(ata_program_id(), false),
        AccountMeta::new_readonly(system_id(), false),
    ]);
    Instruction {
        program_id: program_id(),
        accounts,
        data: ix_data("pump_graduate", &PumpAmountArgs { amount, max_sol_cost }),
    }
}
