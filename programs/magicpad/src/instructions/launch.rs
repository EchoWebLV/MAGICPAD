use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};
use anchor_spl::token::{Mint, Token};
use ephemeral_rollups_sdk::anchor::delegate;
use ephemeral_rollups_sdk::cpi::DelegateConfig;

use crate::constants::*;
use crate::error::MagicPadError;
use crate::state::{Launch, Platform, LAUNCH_BONDING};

// ============================================================================
// A launch costs 1 SOL — that fee IS the anti-spam moat and revenue #1. The
// SPL mint exists from second zero (PDA mint, authority = platform PDA) but
// nothing is EVER minted during bonding: the curve trades ledger claims
// inside the ER. Dark bonding — DexScreener, Photon and the snipe bots see
// a mint with zero supply and zero holders until graduation day.
// ============================================================================

#[derive(Accounts)]
pub struct CreateLaunch<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(mut, seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Box<Account<'info, Platform>>,

    #[account(init, payer = creator, space = 8 + Launch::INIT_SPACE,
        seeds = [LAUNCH_SEED, platform.launch_seq.to_le_bytes().as_ref()], bump)]
    pub launch: Box<Account<'info, Launch>>,

    #[account(init, payer = creator,
        seeds = [MINT_SEED, platform.launch_seq.to_le_bytes().as_ref()], bump,
        mint::decimals = TOKEN_DECIMALS, mint::authority = platform)]
    pub mint: Box<Account<'info, Mint>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn create_launch_handler(
    ctx: Context<CreateLaunch>,
    name: String,
    symbol: String,
) -> Result<()> {
    require!(
        !name.is_empty() && name.len() <= 32,
        MagicPadError::BadMetadata
    );
    require!(
        !symbol.is_empty() && symbol.len() <= 10,
        MagicPadError::BadMetadata
    );

    // the 1 SOL gate, creator → platform
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.key(),
            Transfer {
                from: ctx.accounts.creator.to_account_info(),
                to: ctx.accounts.platform.to_account_info(),
            },
        ),
        LAUNCH_FEE_LAMPORTS,
    )?;

    let now = Clock::get()?.unix_timestamp;
    let id = ctx.accounts.platform.launch_seq;
    let l = &mut ctx.accounts.launch;
    l.id = id;
    l.creator = ctx.accounts.creator.key();
    l.mint = ctx.accounts.mint.key();
    l.name = name;
    l.symbol = symbol;
    l.created_ts = now;
    l.first_window_end_ts = now
        .checked_add(FIRST_WINDOW_SECS)
        .ok_or(MagicPadError::Overflow)?;
    l.state = LAUNCH_BONDING;
    l.virtual_sol = VIRTUAL_SOL_INIT;
    l.virtual_tok = VIRTUAL_TOK_INIT;
    l.real_sol_raised = 0;
    l.tokens_sold = 0;
    l.sessions_reconciled = 0;
    l.sessions_opened = 0;
    l.bump = ctx.bumps.launch;

    ctx.accounts.platform.launch_seq = id.checked_add(1).ok_or(MagicPadError::Overflow)?;
    Ok(())
}

// ---- delegate_launch (L1, creator-or-admin — bundled right after create).
// Hands the launch to the ER while it's still BONDING; from here on the
// curve breathes at rollup speed and L1 sees nothing until graduation. ----
#[delegate]
#[derive(Accounts)]
#[instruction(launch_id: u64)]
pub struct DelegateLaunch<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Box<Account<'info, Platform>>,

    /// CHECK: delegated via the DLP CPI; Unchecked so Anchor doesn't
    /// re-serialize after ownership moves to the delegation program.
    #[account(mut, del, seeds = [LAUNCH_SEED, launch_id.to_le_bytes().as_ref()], bump)]
    pub launch: UncheckedAccount<'info>,
}

pub fn delegate_launch_handler(ctx: Context<DelegateLaunch>, launch_id: u64) -> Result<()> {
    // pre-CPI sanity on the not-yet-delegated data
    {
        let data = ctx.accounts.launch.try_borrow_data()?;
        let l = Launch::try_deserialize(&mut &data[..])?;
        require!(l.id == launch_id, MagicPadError::WrongLaunch);
        require!(l.state == LAUNCH_BONDING, MagicPadError::LaunchNotBonding);
        require!(
            ctx.accounts.payer.key() == l.creator
                || ctx.accounts.payer.key() == ctx.accounts.platform.admin,
            MagicPadError::Unauthorized
        );
    }
    ctx.accounts.delegate_launch(
        &ctx.accounts.payer,
        &[LAUNCH_SEED, &launch_id.to_le_bytes()],
        DelegateConfig {
            // every session that trades this launch must land on the SAME
            // ER node — a trade touches launch + session atomically
            validator: ctx.remaining_accounts.first().map(|a| a.key()),
            ..Default::default()
        },
    )?;
    Ok(())
}
