//! pump.fun instruction shapes. Pure: no accounts, no state — only bytes and
//! keys, so the layouts can be unit-tested without a VM. Verified against
//! mainnet (spec § hard facts): `buy` takes 18 accounts, the last two as
//! remaining accounts; omitting them fails with 6062 BuybackFeeRecipientMissing.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};

pub const PUMP_PROGRAM: Pubkey = pubkey!("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
pub const PUMP_FEE_PROGRAM: Pubkey = pubkey!("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");

pub const BUY_DISC: [u8; 8] = [102, 6, 61, 18, 1, 218, 235, 234];
pub const CLOSE_UVA_DISC: [u8; 8] = [249, 69, 164, 218, 150, 103, 84, 138];
pub const BONDING_CURVE_DISC: [u8; 8] = [23, 183, 248, 55, 96, 216, 172, 96];

/// BondingCurve: disc 8 · vtok@8 · vquote@16 · real_tok@24 · real_quote@32 ·
/// tts@40 · complete@48 · creator@49..81
pub const BONDING_CURVE_MIN_LEN: usize = 81;

pub fn bonding_curve(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"bonding-curve", mint.as_ref()], &PUMP_PROGRAM).0
}

/// buy(amount, max_sol_cost) followed by one trailing 0x01 byte that enables
/// volume tracking: 25 bytes total, proven against the mainnet ELF (spec
/// "hard facts"). This is NOT a two-byte borsh Option<bool> — do not widen it.
pub fn buy_ix_data(amount: u64, max_sol_cost: u64) -> Vec<u8> {
    let mut d = Vec::with_capacity(25);
    d.extend_from_slice(&BUY_DISC);
    d.extend_from_slice(&amount.to_le_bytes());
    d.extend_from_slice(&max_sol_cost.to_le_bytes());
    d.push(1);
    d
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BondingCurveHead {
    pub creator: Pubkey,
    pub complete: bool,
}

/// The two fields set_pump_mint checks. None on a wrong discriminator or a short account.
pub fn parse_bonding_curve(data: &[u8]) -> Option<BondingCurveHead> {
    if data.len() < BONDING_CURVE_MIN_LEN || data[..8] != BONDING_CURVE_DISC {
        return None;
    }
    Some(BondingCurveHead {
        complete: data[48] != 0,
        creator: Pubkey::try_from(&data[49..81]).ok()?,
    })
}

/// Every key pump `buy` reads, in program order. `user` signs.
#[derive(Debug, Clone, Copy)]
pub struct BuyKeys {
    pub global: Pubkey,
    pub fee_recipient: Pubkey,
    pub mint: Pubkey,
    pub bonding_curve: Pubkey,
    pub associated_bonding_curve: Pubkey,
    pub associated_user: Pubkey,
    pub user: Pubkey,
    pub creator_vault: Pubkey,
    pub event_authority: Pubkey,
    pub global_volume_accumulator: Pubkey,
    pub user_volume_accumulator: Pubkey,
    pub fee_config: Pubkey,
    pub bonding_curve_v2: Pubkey,
    pub buyback_fee_recipient: Pubkey,
}

pub fn buy_instruction(k: &BuyKeys, amount: u64, max_sol_cost: u64) -> Instruction {
    Instruction {
        program_id: PUMP_PROGRAM,
        accounts: vec![
            AccountMeta::new_readonly(k.global, false),                     // 0
            AccountMeta::new(k.fee_recipient, false),                       // 1
            AccountMeta::new_readonly(k.mint, false),                       // 2
            AccountMeta::new(k.bonding_curve, false),                       // 3
            AccountMeta::new(k.associated_bonding_curve, false),            // 4
            AccountMeta::new(k.associated_user, false),                     // 5
            AccountMeta::new(k.user, true),                                 // 6
            AccountMeta::new_readonly(anchor_lang::system_program::ID, false), // 7
            AccountMeta::new_readonly(anchor_spl::token::ID, false),        // 8
            AccountMeta::new(k.creator_vault, false),                       // 9
            AccountMeta::new_readonly(k.event_authority, false),            // 10
            AccountMeta::new_readonly(PUMP_PROGRAM, false),                 // 11
            AccountMeta::new_readonly(k.global_volume_accumulator, false),  // 12
            AccountMeta::new(k.user_volume_accumulator, false),             // 13
            AccountMeta::new_readonly(k.fee_config, false),                 // 14
            AccountMeta::new_readonly(PUMP_FEE_PROGRAM, false),             // 15
            AccountMeta::new_readonly(k.bonding_curve_v2, false),           // 16
            AccountMeta::new(k.buyback_fee_recipient, false),               // 17
        ],
        data: buy_ix_data(amount, max_sol_cost),
    }
}

/// close_user_volume_accumulator: rent returns to `user`
pub fn close_uva_instruction(user: Pubkey, uva: Pubkey, event_authority: Pubkey) -> Instruction {
    Instruction {
        program_id: PUMP_PROGRAM,
        accounts: vec![
            AccountMeta::new(user, true),
            AccountMeta::new(uva, false),
            AccountMeta::new_readonly(event_authority, false),
            AccountMeta::new_readonly(PUMP_PROGRAM, false),
        ],
        data: CLOSE_UVA_DISC.to_vec(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buy_data_is_disc_amount_max_flag() {
        let d = buy_ix_data(7, 9);
        assert_eq!(d.len(), 25);
        assert_eq!(&d[..8], &BUY_DISC);
        assert_eq!(u64::from_le_bytes(d[8..16].try_into().unwrap()), 7);
        assert_eq!(u64::from_le_bytes(d[16..24].try_into().unwrap()), 9);
        assert_eq!(d[24], 1);
    }

    #[test]
    fn parse_bonding_curve_reads_creator_and_complete() {
        let creator = Pubkey::new_unique();
        let mut data = vec![0u8; 150];
        data[..8].copy_from_slice(&BONDING_CURVE_DISC);
        data[48] = 1;
        data[49..81].copy_from_slice(creator.as_ref());
        assert_eq!(parse_bonding_curve(&data), Some(BondingCurveHead { creator, complete: true }));
        data[48] = 0;
        assert!(!parse_bonding_curve(&data).unwrap().complete);
    }

    #[test]
    fn parse_bonding_curve_rejects_wrong_disc_and_short_data() {
        let mut data = vec![0u8; 150];
        assert!(parse_bonding_curve(&data).is_none(), "zero disc");
        data[..8].copy_from_slice(&BONDING_CURVE_DISC);
        assert!(parse_bonding_curve(&data[..80]).is_none(), "80 bytes is one short");
    }

    #[test]
    fn buy_instruction_has_18_metas_user_signs() {
        let k = BuyKeys {
            global: Pubkey::new_unique(),
            fee_recipient: Pubkey::new_unique(),
            mint: Pubkey::new_unique(),
            bonding_curve: Pubkey::new_unique(),
            associated_bonding_curve: Pubkey::new_unique(),
            associated_user: Pubkey::new_unique(),
            user: Pubkey::new_unique(),
            creator_vault: Pubkey::new_unique(),
            event_authority: Pubkey::new_unique(),
            global_volume_accumulator: Pubkey::new_unique(),
            user_volume_accumulator: Pubkey::new_unique(),
            fee_config: Pubkey::new_unique(),
            bonding_curve_v2: Pubkey::new_unique(),
            buyback_fee_recipient: Pubkey::new_unique(),
        };
        let ix = buy_instruction(&k, 1, 2);
        assert_eq!(ix.program_id, PUMP_PROGRAM);
        assert_eq!(ix.accounts.len(), 18);
        assert!(ix.accounts[6].is_signer && ix.accounts[6].is_writable);
        assert_eq!(ix.accounts[6].pubkey, k.user);
        assert_eq!(ix.accounts[11].pubkey, PUMP_PROGRAM);
        assert_eq!(ix.accounts[15].pubkey, PUMP_FEE_PROGRAM);
        assert!(ix.accounts[17].is_writable && !ix.accounts[16].is_writable);
        let signers = ix.accounts.iter().filter(|m| m.is_signer).count();
        assert_eq!(signers, 1);
        let close = close_uva_instruction(k.user, k.user_volume_accumulator, k.event_authority);
        assert_eq!(close.accounts.len(), 4);
        assert_eq!(close.data, CLOSE_UVA_DISC.to_vec());
    }

    #[test]
    fn bonding_curve_pda_matches_the_sdk() {
        // pair taken from the litesvm fixture capture (mint from fixtures/meta.txt);
        // expected side computed with @pump-fun/pump-sdk bondingCurvePda(mint)
        let mint = pubkey!("JE91H8efczBQWfjZHmrFwBAC56irajtqXTnFKv1S5hdm");
        assert_eq!(bonding_curve(&mint), pubkey!("F4dJPLrrD6bWfc3YTo1pLrEXLm2btfVab2iNaGhED2Ec"));
    }
}
