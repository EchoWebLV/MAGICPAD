//! The signing-vault plumbing shared by the pump.fun instructions. Both
//! `pump_claim` (per-trader vault) and `pump_graduate` (per-launch vault)
//! fund a system-owned PDA out of the launch pot, let it sign one pump.fun
//! `buy`, and sweep what is left back. Nothing here knows which of the two
//! it is serving — the caller supplies the accounts and the vault seeds.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::system_program::{self, Transfer};
use anchor_spl::token::TokenAccount;

use crate::pump_cpi;

/// pump.fun's `UserVolumeAccumulator` account size (8-byte discriminator +
/// the fields `buy` writes). Opened by a tracked buy, closed right after.
pub(crate) const PUMP_UVA_LEN: usize = 137;

/// Rent the vault must carry on top of max_sol_cost: the trader's ATA
/// (`TokenAccount::LEN` bytes, paid by the vault via create_idempotent),
/// pump's user_volume_accumulator (`PUMP_UVA_LEN` bytes, opened by buy,
/// closed after, refunded to the vault) and the creator vault's rent-exempt
/// minimum for 0 bytes (pump tops it up on first fee). Anything unused flows
/// back to the launch.
pub(crate) fn claim_allowance() -> Result<u64> {
    let r = Rent::get()?;
    Ok(r.minimum_balance(TokenAccount::LEN) + r.minimum_balance(PUMP_UVA_LEN) + r.minimum_balance(0))
}

/// Lamports the launch may spend: everything above its own rent minimum and
/// the outstanding flip pot (which pump_graduate hands to the platform).
pub(crate) fn pot_available(launch: &AccountInfo, flip_pot: i64) -> Result<u64> {
    let rent_min = Rent::get()?.minimum_balance(launch.data_len());
    let pot = if flip_pot > 0 { flip_pot as u64 } else { 0 };
    Ok(launch.lamports().saturating_sub(rent_min).saturating_sub(pot))
}

/// launch → vault. The launch is program-owned, so its lamports can only move
/// by direct arithmetic — and the runtime learns of such a move only for the
/// accounts a CPI actually names (`translate_accounts_common`). Every CPI the
/// vault then signs names the vault but never the launch, so the credit would
/// be visible while the debit was not, and the runtime refuses to enter a CPI
/// whose books do not balance (`UnbalancedInstruction`). A zero-lamport system
/// transfer naming both accounts flushes the pair before the vault spends.
pub(crate) fn fund_vault<'info>(
    launch: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    vault_seeds: &[&[u8]],
    lamports: u64,
) -> Result<()> {
    **launch.try_borrow_mut_lamports()? -= lamports;
    **vault.try_borrow_mut_lamports()? += lamports;
    system_program::transfer(
        CpiContext::new_with_signer(
            system_program.key(),
            Transfer { from: vault.clone(), to: launch.clone() },
            &[vault_seeds],
        ),
        0,
    )
}

/// The pump-side accounts shared by pump_claim and pump_graduate, in the
/// order pump's `buy` reads them (minus mint / associated_user / user).
pub(crate) struct PumpSide<'a, 'info> {
    pub(crate) global: &'a AccountInfo<'info>,
    pub(crate) fee_recipient: &'a AccountInfo<'info>,
    pub(crate) bonding_curve: &'a AccountInfo<'info>,
    pub(crate) associated_bonding_curve: &'a AccountInfo<'info>,
    pub(crate) creator_vault: &'a AccountInfo<'info>,
    pub(crate) event_authority: &'a AccountInfo<'info>,
    pub(crate) pump_program: &'a AccountInfo<'info>,
    pub(crate) global_volume_accumulator: &'a AccountInfo<'info>,
    pub(crate) user_volume_accumulator: &'a AccountInfo<'info>,
    pub(crate) fee_config: &'a AccountInfo<'info>,
    pub(crate) fee_program: &'a AccountInfo<'info>,
    pub(crate) bonding_curve_v2: &'a AccountInfo<'info>,
    pub(crate) buyback_fee_recipient: &'a AccountInfo<'info>,
}

/// Everything `vault_buys` needs besides the amounts: the 13 pump-side
/// accounts plus the four this side of the CPI decides — which mint, whose
/// ATA the tokens land in, which vault signs, and the two programs. One
/// struct so a second `Accounts` type (pump_graduate) fills it the same way.
pub(crate) struct VaultBuy<'a, 'info> {
    pub(crate) side: PumpSide<'a, 'info>,
    pub(crate) mint: &'a AccountInfo<'info>,
    pub(crate) associated_user: &'a AccountInfo<'info>,
    pub(crate) vault: &'a AccountInfo<'info>,
    pub(crate) system_program: &'a AccountInfo<'info>,
    pub(crate) token_program: &'a AccountInfo<'info>,
}

/// vault signs pump `buy` (tokens → `associated_user`), then closes its
/// volume accumulator so the rent returns to the vault.
pub(crate) fn vault_buys(
    b: &VaultBuy<'_, '_>,
    vault_seeds: &[&[u8]],
    amount: u64,
    max_sol_cost: u64,
) -> Result<()> {
    let side = &b.side;
    let keys = pump_cpi::BuyKeys {
        global: side.global.key(),
        fee_recipient: side.fee_recipient.key(),
        mint: b.mint.key(),
        bonding_curve: side.bonding_curve.key(),
        associated_bonding_curve: side.associated_bonding_curve.key(),
        associated_user: b.associated_user.key(),
        user: b.vault.key(),
        creator_vault: side.creator_vault.key(),
        event_authority: side.event_authority.key(),
        global_volume_accumulator: side.global_volume_accumulator.key(),
        user_volume_accumulator: side.user_volume_accumulator.key(),
        fee_config: side.fee_config.key(),
        bonding_curve_v2: side.bonding_curve_v2.key(),
        buyback_fee_recipient: side.buyback_fee_recipient.key(),
    };
    let ix = pump_cpi::buy_instruction(&keys, amount, max_sol_cost);
    invoke_signed(
        &ix,
        &[
            side.global.clone(),
            side.fee_recipient.clone(),
            b.mint.clone(),
            side.bonding_curve.clone(),
            side.associated_bonding_curve.clone(),
            b.associated_user.clone(),
            b.vault.clone(),
            b.system_program.clone(),
            b.token_program.clone(),
            side.creator_vault.clone(),
            side.event_authority.clone(),
            side.pump_program.clone(),
            side.global_volume_accumulator.clone(),
            side.user_volume_accumulator.clone(),
            side.fee_config.clone(),
            side.fee_program.clone(),
            side.bonding_curve_v2.clone(),
            side.buyback_fee_recipient.clone(),
        ],
        &[vault_seeds],
    )?;
    if !side.user_volume_accumulator.data_is_empty() {
        let close = pump_cpi::close_uva_instruction(
            b.vault.key(),
            side.user_volume_accumulator.key(),
            side.event_authority.key(),
        );
        invoke_signed(
            &close,
            &[
                b.vault.clone(),
                side.user_volume_accumulator.clone(),
                side.event_authority.clone(),
                side.pump_program.clone(),
            ],
            &[vault_seeds],
        )?;
    }
    Ok(())
}

/// every lamport in the vault → launch (system transfer, vault signs)
pub(crate) fn sweep_vault<'info>(
    vault: &AccountInfo<'info>,
    launch: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    vault_seeds: &[&[u8]],
) -> Result<()> {
    let left = vault.lamports();
    if left > 0 {
        system_program::transfer(
            CpiContext::new_with_signer(
                system_program.key(),
                Transfer { from: vault.clone(), to: launch.clone() },
                &[vault_seeds],
            ),
            left,
        )?;
    }
    Ok(())
}
