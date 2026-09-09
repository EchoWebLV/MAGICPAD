//! pump.fun mode. The PumpLaunch PDA is the switch; the four instructions
//! here are enable (creator, before any trade), set_pump_mint (admin, once
//! the CLI created the pump token), pump_claim (per session — the vault buys
//! the trader's share on pump.fun) and pump_graduate (the remainder is burnt
//! through a buy, residue to the platform, Mooner mint revoked).
use anchor_lang::prelude::*;
use anchor_spl::associated_token::{self, AssociatedToken, Create};
use anchor_spl::token::spl_token::instruction::AuthorityType;
use anchor_spl::token::{self, Burn, CloseAccount, Mint, SetAuthority, Token, TokenAccount};

use super::pump_vault::{
    claim_allowance, fund_vault, pot_available, sweep_vault, vault_buys, PumpSide, VaultBuy,
};
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

#[derive(Accounts)]
pub struct PumpClaim<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    /// The crank is deliberately NOT permissionless: `amount` is chosen by
    /// the caller, so a stranger could hand a holder one token and burn the
    /// single claim the session gets. Read only for the admin check.
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Box<Account<'info, Platform>>,
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
    // who may crank: the keeper (platform admin) or the holder herself. A
    // caller-chosen `amount` is a weapon in a stranger's hands — one token
    // into the ATA marks tokens_claimed and the real share is gone.
    require!(
        ctx.accounts.cranker.key() == ctx.accounts.platform.admin
            || ctx.accounts.cranker.key() == ctx.accounts.session.trader,
        MagicPadError::Unauthorized
    );
    // set_pump_mint accepts a FROZEN launch, so the pin can land while
    // winners are still unreconciled — and their profit comes out of this
    // very pot, which pot_available reserves nothing for. Claims wait until
    // every session has settled.
    require!(
        ctx.accounts.launch.state == LAUNCH_RECONCILED,
        MagicPadError::LaunchNotReconciled
    );
    let s = &ctx.accounts.session;
    // still reachable on a RECONCILED launch: a session that never traded is
    // not counted in sessions_opened, so the launch can reconcile without it
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
        let need = max_sol_cost.checked_add(claim_allowance()?).ok_or(MagicPadError::Overflow)?;
        require!(
            need <= pot_available(&launch_ai, ctx.accounts.launch.flip_pot)?,
            MagicPadError::PotTooSmall
        );

        let id_bytes = ctx.accounts.launch.id.to_le_bytes();
        let trader_key = ctx.accounts.trader.key();
        let vault_bump = [ctx.bumps.vault];
        let vault_seeds: &[&[u8]] = &[PUMP_VAULT_SEED, &id_bytes, trader_key.as_ref(), &vault_bump];
        let vault = ctx.accounts.vault.to_account_info();
        let mint_ai = ctx.accounts.pump_mint.to_account_info();
        let ata_ai = ctx.accounts.trader_ata.to_account_info();
        let system_ai = ctx.accounts.system_program.to_account_info();
        let token_ai = ctx.accounts.token_program.to_account_info();

        fund_vault(&launch_ai, &vault, &system_ai, vault_seeds, need)?;
        associated_token::create_idempotent(CpiContext::new_with_signer(
            ctx.accounts.associated_token_program.key(),
            Create {
                payer: vault.clone(),
                associated_token: ata_ai.clone(),
                authority: ctx.accounts.trader.to_account_info(),
                mint: mint_ai.clone(),
                system_program: system_ai.clone(),
                token_program: token_ai.clone(),
            },
            &[vault_seeds],
        ))?;
        vault_buys(
            &VaultBuy {
                side: ctx.accounts.side(),
                mint: &mint_ai,
                associated_user: &ata_ai,
                vault: &vault,
                system_program: &system_ai,
                token_program: &token_ai,
            },
            vault_seeds,
            amount,
            max_sol_cost,
        )?;
        sweep_vault(&vault, &launch_ai, &system_ai, vault_seeds)?;
    }

    let s = &mut ctx.accounts.session;
    s.tokens_claimed = true;
    // sessions_opened counts sessions that bought at least once (trade.rs);
    // mirror it so pump_graduate's completeness check lines up
    if s.sol_spent > 0 {
        let p = &mut ctx.accounts.pump;
        p.claims_done = p.claims_done.checked_add(1).ok_or(MagicPadError::Overflow)?;
    }
    Ok(())
}
