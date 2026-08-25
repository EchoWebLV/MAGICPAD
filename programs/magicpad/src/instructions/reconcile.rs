use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, MintTo, SetAuthority, Token, TokenAccount};
use anchor_spl::token::spl_token::instruction::AuthorityType;

use crate::constants::*;
use crate::error::MagicPadError;
use crate::state::{
    Launch, MigratedPool, Platform, PlatformConfig, TradeSession, LAUNCH_FROZEN, LAUNCH_GRADUATED,
    LAUNCH_RECONCILED,
};

// ============================================================================
// The L1 landing — cash follows ledger. Reconcile is a PERMISSIONLESS crank
// with no signer field on purpose: the math is fully determined by the
// committed ledger and every payout target is pinned to session.trader, so
// a stranger paying the fee can only settle CORRECTLY. Typed Account<>
// fields double as the undelegation gate — a still-delegated PDA is owned
// by the delegation program and cannot pass Anchor's owner check.
// ============================================================================

// ---- reconcile_trade_session: net loser's SOL → launch pot, net winner's
// profit ← launch pot, untouched remainder → trader wallet. Winners whose
// profit isn't funded yet fail-and-retry until loser sessions land — the
// system heals in order, nobody can be overpaid early. ----
#[derive(Accounts)]
pub struct ReconcileTradeSession<'info> {
    /// CHECK: payout target — pinned to the session's recorded trader.
    #[account(mut, constraint = trader.key() == session.trader @ MagicPadError::Unauthorized)]
    pub trader: UncheckedAccount<'info>,

    #[account(mut,
        seeds = [LAUNCH_SEED, launch.id.to_le_bytes().as_ref()], bump = launch.bump,
        constraint = launch.id == session.launch_id @ MagicPadError::WrongLaunch)]
    pub launch: Box<Account<'info, Launch>>,

    // Account<> re-checks program ownership = the "is it undelegated yet"
    // gate: a still-delegated session is DLP-owned and simply cannot pass
    // here until commit_trade_sessions brings it home.
    #[account(mut,
        seeds = [SESSION_SEED, session.launch_id.to_le_bytes().as_ref(), session.trader.as_ref()],
        bump = session.bump)]
    pub session: Box<Account<'info, TradeSession>>,
}

pub fn reconcile_trade_session_handler(ctx: Context<ReconcileTradeSession>) -> Result<()> {
    let (deposit, spent, proceeds) = {
        let s = &ctx.accounts.session;
        let l = &ctx.accounts.launch;
        // launch typed + FROZEN-or-later proves the launch itself is home,
        // so the pot we fund is the pot graduation drains
        require!(l.state >= LAUNCH_FROZEN, MagicPadError::LaunchNotFrozen);
        require!(!s.reconciled, MagicPadError::AlreadyReconciled);
        (s.deposit, s.sol_spent, s.sol_proceeds)
    };

    let session_ai = ctx.accounts.session.to_account_info();
    let launch_ai = ctx.accounts.launch.to_account_info();
    let trader_ai = ctx.accounts.trader.to_account_info();

    // rent stays with the PDA; only the escrow moves
    let s_rent = Rent::get()?.minimum_balance(session_ai.data_len());
    require!(
        session_ai.lamports() >= s_rent.checked_add(deposit).ok_or(MagicPadError::Overflow)?,
        MagicPadError::Overflow
    );

    if spent >= proceeds {
        // net loser (or flat): net into the pot, the rest walks home
        let net = spent - proceeds;
        require!(net <= deposit, MagicPadError::Overflow); // ER invariant, re-checked
        **session_ai.try_borrow_mut_lamports()? -= deposit;
        **launch_ai.try_borrow_mut_lamports()? += net;
        **trader_ai.try_borrow_mut_lamports()? += deposit - net;
    } else {
        // net winner: profit is paid FROM the pot. Until losers' nets have
        // landed the pot may be short — clean error, crank retries later.
        let profit = proceeds - spent;
        let l_rent = Rent::get()?.minimum_balance(launch_ai.data_len());
        require!(
            launch_ai.lamports() >= l_rent.checked_add(profit).ok_or(MagicPadError::Overflow)?,
            MagicPadError::PotNotReady
        );
        **session_ai.try_borrow_mut_lamports()? -= deposit;
        **launch_ai.try_borrow_mut_lamports()? -= profit;
        **trader_ai.try_borrow_mut_lamports()? +=
            deposit.checked_add(profit).ok_or(MagicPadError::Overflow)?;
    }

    ctx.accounts.session.reconciled = true;
    // only sessions that actually traded were counted (first-buy bump in
    // the ER), so only those tick the settlement counter here
    if spent > 0 {
        let l = &mut ctx.accounts.launch;
        l.sessions_reconciled = l
            .sessions_reconciled
            .checked_add(1)
            .ok_or(MagicPadError::Overflow)?;
        if l.state == LAUNCH_FROZEN && l.sessions_reconciled == l.sessions_opened {
            l.state = LAUNCH_RECONCILED;
        }
    }
    Ok(())
}

// ---- claim_tokens: dark bonding ends here. The ledger claim becomes a
// real SPL balance — the FIRST mint this token ever sees. Permissionless
// crank; recipient pinned to session.trader (stranger-crank-safe). ----
#[derive(Accounts)]
pub struct ClaimTokens<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>, // pays ATA rent if needed; anyone

    /// CHECK: ATA owner — pinned to the session's recorded trader.
    #[account(constraint = trader.key() == session.trader @ MagicPadError::Unauthorized)]
    pub trader: UncheckedAccount<'info>,

    #[account(seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Box<Account<'info, Platform>>,

    #[account(seeds = [LAUNCH_SEED, launch.id.to_le_bytes().as_ref()], bump = launch.bump,
        constraint = launch.id == session.launch_id @ MagicPadError::WrongLaunch)]
    pub launch: Box<Account<'info, Launch>>,

    #[account(mut,
        seeds = [SESSION_SEED, session.launch_id.to_le_bytes().as_ref(), session.trader.as_ref()],
        bump = session.bump)]
    pub session: Box<Account<'info, TradeSession>>,

    #[account(mut, seeds = [MINT_SEED, launch.id.to_le_bytes().as_ref()], bump,
        constraint = mint.key() == launch.mint @ MagicPadError::WrongLaunch)]
    pub mint: Box<Account<'info, Mint>>,

    #[account(init_if_needed, payer = cranker,
        associated_token::mint = mint, associated_token::authority = trader)]
    pub trader_ata: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn claim_tokens_handler(ctx: Context<ClaimTokens>) -> Result<()> {
    let s = &ctx.accounts.session;
    require!(s.reconciled, MagicPadError::NotReconciled);
    require!(!s.tokens_claimed, MagicPadError::AlreadyClaimed);
    require!(s.tokens_held > 0, MagicPadError::NothingToClaim);

    let bump = [ctx.accounts.platform.bump];
    let seeds: &[&[u8]] = &[PLATFORM_SEED, &bump];
    // anchor-lang 1.0: CpiContext takes the program id
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            MintTo {
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.trader_ata.to_account_info(),
                authority: ctx.accounts.platform.to_account_info(),
            },
            &[seeds],
        ),
        s.tokens_held,
    )?;

    ctx.accounts.session.tokens_claimed = true;
    Ok(())
}

// ---- graduate (L1, admin): loud graduation. Every session reconciled,
// threshold met → the raised SOL and leftover tokens leave for the admin
// seed wallet. scripts/migrate.mjs opens the Meteora DAMM v2 pool at the
// frozen curve price, burns the excess, locks the LP, lock_mint revokes
// mint authority, and record_pool writes the pool CA to a mint-seeded PDA.
// On-chain Meteora CPI is v2.
#[derive(Accounts)]
pub struct Graduate<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(mut, seeds = [PLATFORM_SEED], bump = platform.bump,
        constraint = platform.admin == admin.key() @ MagicPadError::Unauthorized)]
    pub platform: Box<Account<'info, Platform>>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, PlatformConfig>>,

    #[account(mut, seeds = [LAUNCH_SEED, launch.id.to_le_bytes().as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, Launch>>,

    #[account(mut, seeds = [MINT_SEED, launch.id.to_le_bytes().as_ref()], bump,
        constraint = mint.key() == launch.mint @ MagicPadError::WrongLaunch)]
    pub mint: Box<Account<'info, Mint>>,

    #[account(init_if_needed, payer = admin,
        associated_token::mint = mint, associated_token::authority = admin)]
    pub admin_ata: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn graduate_handler(ctx: Context<Graduate>) -> Result<()> {
    let (raised, lp_tokens) = {
        let l = &ctx.accounts.launch;
        let settled = l.state == LAUNCH_RECONCILED
            || (l.state == LAUNCH_FROZEN && l.sessions_reconciled == l.sessions_opened);
        require!(settled, MagicPadError::NotGraduatable);
        require!(
            l.real_sol_raised >= GRADUATION_LAMPORTS,
            MagicPadError::NotGraduatable
        );
        let lp = TOKEN_TOTAL_SUPPLY
            .checked_sub(l.tokens_sold)
            .ok_or(MagicPadError::Overflow)?;
        (l.real_sol_raised, lp)
    };

    // SOL side: admin pre-pays tax to the platform via system transfer
    // (direct += on a program-owned account doesn't commit in this
    // runtime), then the full pot moves launch → admin. Net: platform
    // gets tax, admin gets raised - tax.
    let tax = u64::try_from(
        raised as u128 * ctx.accounts.config.launch_tax_bps as u128 / BPS_DENOM as u128,
    )
    .map_err(|_| MagicPadError::Overflow)?;
    let launch_ai = ctx.accounts.launch.to_account_info();
    let rent_min = Rent::get()?.minimum_balance(launch_ai.data_len());
    require!(
        launch_ai.lamports() >= rent_min.checked_add(raised).ok_or(MagicPadError::Overflow)?,
        MagicPadError::PotNotReady
    );
    if tax > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer {
                    from: ctx.accounts.admin.to_account_info(),
                    to: ctx.accounts.platform.to_account_info(),
                },
            ),
            tax,
        )?;
    }
    **launch_ai.try_borrow_mut_lamports()? -= raised;
    **ctx.accounts.admin.to_account_info().try_borrow_mut_lamports()? += raised;

    // token side: everything the curve didn't sell seeds the pool
    if lp_tokens > 0 {
        let bump = [ctx.accounts.platform.bump];
        let seeds: &[&[u8]] = &[PLATFORM_SEED, &bump];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.admin_ata.to_account_info(),
                    authority: ctx.accounts.platform.to_account_info(),
                },
                &[seeds],
            ),
            lp_tokens,
        )?;
    }

    ctx.accounts.launch.state = LAUNCH_GRADUATED;
    Ok(())
}

// ---- lock_mint (L1, permissionless). Once every claim has minted and
// graduate has minted the leftover, supply == TOKEN_TOTAL_SUPPLY and the
// mint authority is still the platform PDA. Revoke it so nobody can print
// after the Meteora seed. Fails clean if a claim is still outstanding.
#[derive(Accounts)]
pub struct LockMint<'info> {
    #[account(seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Box<Account<'info, Platform>>,

    #[account(seeds = [LAUNCH_SEED, launch.id.to_le_bytes().as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, Launch>>,

    #[account(mut, seeds = [MINT_SEED, launch.id.to_le_bytes().as_ref()], bump,
        constraint = mint.key() == launch.mint @ MagicPadError::WrongLaunch)]
    pub mint: Box<Account<'info, Mint>>,

    pub token_program: Program<'info, Token>,
}

pub fn lock_mint_handler(ctx: Context<LockMint>) -> Result<()> {
    require!(
        ctx.accounts.launch.state == LAUNCH_GRADUATED,
        MagicPadError::NotGraduatable
    );
    // every claim must already be minted — graduate minted the leftover, so
    // supply == TOTAL iff no trader is still waiting on claim_tokens.
    // lock THEN burn leftover; burning first would fail this check and
    // would also have allowed locking while claims were still outstanding.
    require!(
        ctx.accounts.mint.supply == TOKEN_TOTAL_SUPPLY,
        MagicPadError::MintNotReady
    );
    require!(
        ctx.accounts.mint.mint_authority.is_some(),
        MagicPadError::AlreadyLocked
    );

    let bump = [ctx.accounts.platform.bump];
    let seeds: &[&[u8]] = &[PLATFORM_SEED, &bump];
    token::set_authority(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            SetAuthority {
                current_authority: ctx.accounts.platform.to_account_info(),
                account_or_mint: ctx.accounts.mint.to_account_info(),
            },
            &[seeds],
        ),
        AuthorityType::MintTokens,
        None,
    )?;
    Ok(())
}

// ---- record_pool (L1, admin). After migrate.mjs opens the DAMM v2 pool,
// pin its address on a mint-seeded PDA so any client (swap API, board)
// can resolve it from the CA. Immutable: init-only, no overwrite.
#[derive(Accounts)]
pub struct RecordPool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(seeds = [PLATFORM_SEED], bump = platform.bump,
        constraint = platform.admin == admin.key() @ MagicPadError::Unauthorized)]
    pub platform: Box<Account<'info, Platform>>,

    #[account(seeds = [LAUNCH_SEED, launch.id.to_le_bytes().as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, Launch>>,

    #[account(seeds = [MINT_SEED, launch.id.to_le_bytes().as_ref()], bump,
        constraint = mint.key() == launch.mint @ MagicPadError::WrongLaunch)]
    pub mint: Box<Account<'info, Mint>>,

    #[account(init, payer = admin, space = 8 + MigratedPool::INIT_SPACE,
        seeds = [POOL_SEED, mint.key().as_ref()], bump)]
    pub migrated_pool: Box<Account<'info, MigratedPool>>,

    pub system_program: Program<'info, System>,
}

pub fn record_pool_handler(ctx: Context<RecordPool>, pool: Pubkey) -> Result<()> {
    require!(
        ctx.accounts.launch.state == LAUNCH_GRADUATED,
        MagicPadError::NotGraduatable
    );
    require!(pool != Pubkey::default(), MagicPadError::BadPool);

    let rec = &mut ctx.accounts.migrated_pool;
    rec.launch_id = ctx.accounts.launch.id;
    rec.mint = ctx.accounts.mint.key();
    rec.pool = pool;
    rec.bump = ctx.bumps.migrated_pool;
    Ok(())
}
