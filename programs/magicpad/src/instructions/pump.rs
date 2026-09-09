//! pump.fun mode. The PumpLaunch PDA is the switch; the four instructions
//! here are enable (creator, before any trade), set_pump_mint (admin, once
//! the CLI created the pump token), pump_claim (per session — the vault buys
//! the trader's share on pump.fun) and pump_graduate (the remainder is burnt
//! through a buy, residue to the platform, Mooner mint revoked).
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::system_program::{self, Transfer};
use anchor_spl::associated_token::{self, AssociatedToken, Create};
use anchor_spl::token::spl_token::instruction::AuthorityType;
use anchor_spl::token::{self, Burn, CloseAccount, Mint, SetAuthority, Token, TokenAccount};

use crate::constants::*;
use crate::error::MagicPadError;
use crate::pump_cpi;
use crate::state::{
    Launch, Platform, PumpLaunch, TradeSession, LAUNCH_BONDING, LAUNCH_FROZEN, LAUNCH_GRADUATED,
    LAUNCH_RECONCILED,
};

#[derive(Accounts)]
#[instruction(launch_id: u64)]
pub struct EnablePump<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    /// `Account<>` on purpose: the owner check IS the "before delegate_launch"
    /// guard. Once delegated the launch is DLP-owned and this instruction is
    /// permanently unreachable (no undelegate path while BONDING), so the
    /// create tx must bundle enable_pump ahead of delegate_launch.
    #[account(
        seeds = [LAUNCH_SEED, launch_id.to_le_bytes().as_ref()],
        bump = launch.bump,
        constraint = launch.creator == creator.key() @ MagicPadError::Unauthorized,
    )]
    pub launch: Box<Account<'info, Launch>>,
    #[account(
        init,
        payer = creator,
        space = 8 + PumpLaunch::INIT_SPACE,
        seeds = [PUMP_SEED, launch_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub pump: Box<Account<'info, PumpLaunch>>,
    pub system_program: Program<'info, System>,
}

pub fn enable_pump_handler(ctx: Context<EnablePump>, launch_id: u64) -> Result<()> {
    let l = &ctx.accounts.launch;
    // the 1 SOL line only makes sense for a market nobody has priced yet
    require!(
        l.state == LAUNCH_BONDING && l.real_sol_raised == 0 && l.tokens_sold == 0,
        MagicPadError::PumpTooLate
    );
    let p = &mut ctx.accounts.pump;
    p.launch_id = launch_id;
    p.pump_mint = Pubkey::default();
    p.claims_done = 0;
    p.bump = ctx.bumps.pump;
    Ok(())
}

#[derive(Accounts)]
pub struct SetPumpMint<'info> {
    pub admin: Signer<'info>,
    #[account(
        seeds = [PLATFORM_SEED],
        bump = platform.bump,
        constraint = platform.admin == admin.key() @ MagicPadError::Unauthorized,
    )]
    pub platform: Box<Account<'info, Platform>>,
    /// Typed `Account<>` on purpose: the owner check means the launch must be
    /// home (`commit_launch` undelegated it) before the admin can pin.
    #[account(seeds = [LAUNCH_SEED, launch.id.to_le_bytes().as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, Launch>>,
    #[account(
        mut,
        seeds = [PUMP_SEED, launch.id.to_le_bytes().as_ref()],
        bump = pump.bump,
        constraint = pump.launch_id == launch.id @ MagicPadError::WrongLaunch,
    )]
    pub pump: Box<Account<'info, PumpLaunch>>,
    /// CHECK: the pump.fun mint; only its key is recorded, the curve proves it
    pub pump_mint: UncheckedAccount<'info>,
    /// CHECK: pump's BondingCurve for pump_mint — owner + derivation checked here, creator/complete in the handler
    #[account(
        owner = pump_cpi::PUMP_PROGRAM @ MagicPadError::BadPumpAccount,
        address = pump_cpi::bonding_curve(&pump_mint.key()) @ MagicPadError::BadPumpAccount,
    )]
    pub pump_bonding_curve: UncheckedAccount<'info>,
}

pub fn set_pump_mint_handler(ctx: Context<SetPumpMint>) -> Result<()> {
    let l = &ctx.accounts.launch;
    require!(
        l.state == LAUNCH_FROZEN || l.state == LAUNCH_RECONCILED,
        MagicPadError::LaunchNotFrozen
    );
    let p = &mut ctx.accounts.pump;
    require!(p.pump_mint == Pubkey::default(), MagicPadError::PumpMintAlreadySet);
    let head = pump_cpi::parse_bonding_curve(&ctx.accounts.pump_bonding_curve.try_borrow_data()?)
        .ok_or(MagicPadError::BadPumpAccount)?;
    // the pump token must be OURS (creator = launch creator) …
    require!(head.creator == l.creator, MagicPadError::BadPumpAccount);
    // … and still on its curve (a completed curve refuses buys; the pin is one-shot)
    require!(!head.complete, MagicPadError::BadPumpAccount);
    p.pump_mint = ctx.accounts.pump_mint.key();
    Ok(())
}

/// Rent the vault must carry on top of max_sol_cost: the trader's ATA (165
/// bytes, paid by the vault via create_idempotent), pump's
/// user_volume_accumulator (137 bytes, opened by buy, closed after, refunded
/// to the vault) and the creator vault's rent-exempt minimum for 0 bytes
/// (pump tops it up on first fee). Anything unused flows back to the launch.
fn claim_allowance() -> Result<u64> {
    let r = Rent::get()?;
    Ok(r.minimum_balance(165) + r.minimum_balance(137) + r.minimum_balance(0))
}

/// Lamports the launch may spend: everything above its own rent minimum and
/// the outstanding flip pot (which pump_graduate hands to the platform).
fn pot_available(launch: &AccountInfo, flip_pot: i64) -> Result<u64> {
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
fn fund_vault<'info>(
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
struct PumpSide<'a, 'info> {
    global: &'a AccountInfo<'info>,
    fee_recipient: &'a AccountInfo<'info>,
    bonding_curve: &'a AccountInfo<'info>,
    associated_bonding_curve: &'a AccountInfo<'info>,
    creator_vault: &'a AccountInfo<'info>,
    event_authority: &'a AccountInfo<'info>,
    pump_program: &'a AccountInfo<'info>,
    global_volume_accumulator: &'a AccountInfo<'info>,
    user_volume_accumulator: &'a AccountInfo<'info>,
    fee_config: &'a AccountInfo<'info>,
    fee_program: &'a AccountInfo<'info>,
    bonding_curve_v2: &'a AccountInfo<'info>,
    buyback_fee_recipient: &'a AccountInfo<'info>,
}

/// vault signs pump `buy` (tokens → `associated_user`), then closes its
/// volume accumulator so the rent returns to the vault.
#[allow(clippy::too_many_arguments)]
fn vault_buys<'info>(
    side: &PumpSide<'_, 'info>,
    mint: &AccountInfo<'info>,
    associated_user: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    vault_seeds: &[&[u8]],
    amount: u64,
    max_sol_cost: u64,
) -> Result<()> {
    let keys = pump_cpi::BuyKeys {
        global: side.global.key(),
        fee_recipient: side.fee_recipient.key(),
        mint: mint.key(),
        bonding_curve: side.bonding_curve.key(),
        associated_bonding_curve: side.associated_bonding_curve.key(),
        associated_user: associated_user.key(),
        user: vault.key(),
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
            mint.clone(),
            side.bonding_curve.clone(),
            side.associated_bonding_curve.clone(),
            associated_user.clone(),
            vault.clone(),
            system_program.clone(),
            token_program.clone(),
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
            vault.key(),
            side.user_volume_accumulator.key(),
            side.event_authority.key(),
        );
        invoke_signed(
            &close,
            &[
                vault.clone(),
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
fn sweep_vault<'info>(
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

#[derive(Accounts)]
pub struct PumpClaim<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    /// CHECK: pinned to the session below
    #[account(constraint = trader.key() == session.trader @ MagicPadError::Unauthorized)]
    pub trader: UncheckedAccount<'info>,
    #[account(mut, seeds = [LAUNCH_SEED, launch.id.to_le_bytes().as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, Launch>>,
    #[account(
        mut,
        seeds = [PUMP_SEED, launch.id.to_le_bytes().as_ref()],
        bump = pump.bump,
        constraint = pump.pump_mint != Pubkey::default() @ MagicPadError::PumpMintNotSet,
        constraint = pump.pump_mint == pump_mint.key() @ MagicPadError::WrongPumpMint,
    )]
    pub pump: Box<Account<'info, PumpLaunch>>,
    #[account(
        mut,
        seeds = [SESSION_SEED, session.launch_id.to_le_bytes().as_ref(), session.trader.as_ref()],
        bump = session.bump,
        constraint = session.launch_id == launch.id @ MagicPadError::WrongLaunch,
    )]
    pub session: Box<Account<'info, TradeSession>>,
    /// CHECK: per-session signing vault, funded from the launch for one buy and swept back
    #[account(mut, seeds = [PUMP_VAULT_SEED, launch.id.to_le_bytes().as_ref(), session.trader.as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: equals pump.pump_mint (constraint above)
    pub pump_mint: UncheckedAccount<'info>,
    /// CHECK: the trader's ATA for pump_mint — derivation checked in the handler; created by the vault
    #[account(mut)]
    pub trader_ata: UncheckedAccount<'info>,
    // ---- pump.fun's own accounts; pump validates each of them ----
    /// CHECK: pump global
    pub pump_global: UncheckedAccount<'info>,
    /// CHECK: pump fee recipient
    #[account(mut)]
    pub pump_fee_recipient: UncheckedAccount<'info>,
    /// CHECK: pump bonding curve
    #[account(mut)]
    pub pump_bonding_curve: UncheckedAccount<'info>,
    /// CHECK: bonding curve's ATA
    #[account(mut)]
    pub pump_associated_bonding_curve: UncheckedAccount<'info>,
    /// CHECK: creator vault
    #[account(mut)]
    pub pump_creator_vault: UncheckedAccount<'info>,
    /// CHECK: pump event authority
    pub pump_event_authority: UncheckedAccount<'info>,
    /// CHECK: pump program
    #[account(address = pump_cpi::PUMP_PROGRAM @ MagicPadError::BadPumpAccount)]
    pub pump_program: UncheckedAccount<'info>,
    /// CHECK: global volume accumulator
    pub pump_global_volume_accumulator: UncheckedAccount<'info>,
    /// CHECK: the VAULT's user volume accumulator (opened by buy, closed after)
    #[account(mut)]
    pub pump_user_volume_accumulator: UncheckedAccount<'info>,
    /// CHECK: fee config
    pub pump_fee_config: UncheckedAccount<'info>,
    /// CHECK: pump fee program
    #[account(address = pump_cpi::PUMP_FEE_PROGRAM @ MagicPadError::BadPumpAccount)]
    pub pump_fee_program: UncheckedAccount<'info>,
    /// CHECK: bonding curve v2
    pub pump_bonding_curve_v2: UncheckedAccount<'info>,
    /// CHECK: buyback fee recipient
    #[account(mut)]
    pub pump_buyback_fee_recipient: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

impl<'info> PumpClaim<'info> {
    fn side<'a>(&'a self) -> PumpSide<'a, 'info> {
        PumpSide {
            global: &self.pump_global,
            fee_recipient: &self.pump_fee_recipient,
            bonding_curve: &self.pump_bonding_curve,
            associated_bonding_curve: &self.pump_associated_bonding_curve,
            creator_vault: &self.pump_creator_vault,
            event_authority: &self.pump_event_authority,
            pump_program: &self.pump_program,
            global_volume_accumulator: &self.pump_global_volume_accumulator,
            user_volume_accumulator: &self.pump_user_volume_accumulator,
            fee_config: &self.pump_fee_config,
            fee_program: &self.pump_fee_program,
            bonding_curve_v2: &self.pump_bonding_curve_v2,
            buyback_fee_recipient: &self.pump_buyback_fee_recipient,
        }
    }
}

pub fn pump_claim_handler(ctx: Context<PumpClaim>, amount: u64, max_sol_cost: u64) -> Result<()> {
    let s = &ctx.accounts.session;
    require!(s.reconciled, MagicPadError::NotReconciled);
    require!(!s.tokens_claimed, MagicPadError::AlreadyClaimed);
    require_keys_eq!(
        ctx.accounts.trader_ata.key(),
        anchor_spl::associated_token::get_associated_token_address(
            &ctx.accounts.trader.key(),
            &ctx.accounts.pump_mint.key(),
        ),
        MagicPadError::BadPumpAccount
    );

    if s.tokens_held == 0 {
        // flat session: nothing to buy, just close the books
        require!(amount == 0, MagicPadError::ClaimTooLarge);
    } else {
        require!(amount > 0, MagicPadError::BadQuote);
        let ceiling = (s.tokens_held as u128 * (BPS_DENOM - PUMP_HAIRCUT_BPS) as u128
            / BPS_DENOM as u128) as u64;
        require!(amount <= ceiling, MagicPadError::ClaimTooLarge);

        let launch_ai = ctx.accounts.launch.to_account_info();
        let need = max_sol_cost.checked_add(claim_allowance()?).ok_or(MagicPadError::BadQuote)?;
        require!(
            need <= pot_available(&launch_ai, ctx.accounts.launch.flip_pot)?,
            MagicPadError::PotTooSmall
        );

        let id_bytes = ctx.accounts.launch.id.to_le_bytes();
        let trader_key = ctx.accounts.trader.key();
        let vault_bump = [ctx.bumps.vault];
        let vault_seeds: &[&[u8]] = &[PUMP_VAULT_SEED, &id_bytes, trader_key.as_ref(), &vault_bump];
        let vault = ctx.accounts.vault.to_account_info();

        fund_vault(
            &launch_ai,
            &vault,
            &ctx.accounts.system_program.to_account_info(),
            vault_seeds,
            need,
        )?;
        associated_token::create_idempotent(CpiContext::new_with_signer(
            ctx.accounts.associated_token_program.key(),
            Create {
                payer: vault.clone(),
                associated_token: ctx.accounts.trader_ata.to_account_info(),
                authority: ctx.accounts.trader.to_account_info(),
                mint: ctx.accounts.pump_mint.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
            &[vault_seeds],
        ))?;
        vault_buys(
            &ctx.accounts.side(),
            &ctx.accounts.pump_mint.to_account_info(),
            &ctx.accounts.trader_ata.to_account_info(),
            &vault,
            &ctx.accounts.system_program.to_account_info(),
            &ctx.accounts.token_program.to_account_info(),
            vault_seeds,
            amount,
            max_sol_cost,
        )?;
        sweep_vault(&vault, &launch_ai, &ctx.accounts.system_program.to_account_info(), vault_seeds)?;
    }

    let s = &mut ctx.accounts.session;
    s.tokens_claimed = true;
    // sessions_opened counts sessions that bought at least once (trade.rs);
    // mirror it so pump_graduate's completeness check lines up
    if s.sol_spent > 0 {
        ctx.accounts.pump.claims_done += 1;
    }
    Ok(())
}
