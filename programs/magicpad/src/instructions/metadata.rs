use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token::Mint;

use crate::constants::*;
use crate::error::MagicPadError;
use crate::state::{Launch, Platform};

// ============================================================================
// The token's public face. The mint is a PDA and its authority is the
// platform PDA, so only this program can sign Metaplex's CreateMetadataAccountV3
// — hand-rolled CPI (discriminator 33), no mpl crate in the pinned dep graph.
// Name and symbol come from the launch account: the face always matches what
// the market was created as. Callable until lock_mint revokes the authority.
// ============================================================================

pub const TOKEN_METADATA_PROGRAM: Pubkey = pubkey!("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const MAX_URI_LEN: usize = 200; // Metaplex MAX_URI_LENGTH

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct SetTokenMetadata<'info> {
    #[account(mut, address = platform.admin)]
    pub admin: Signer<'info>,

    #[account(seeds = [PLATFORM_SEED], bump = platform.bump)]
    pub platform: Box<Account<'info, Platform>>,

    #[account(seeds = [LAUNCH_SEED, id.to_le_bytes().as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, Launch>>,

    #[account(seeds = [MINT_SEED, id.to_le_bytes().as_ref()], bump,
        constraint = launch.mint == mint.key() @ MagicPadError::BadMetadata)]
    pub mint: Box<Account<'info, Mint>>,

    /// CHECK: created by the token-metadata program; address verified in the handler
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,

    /// CHECK: pinned to the Metaplex token-metadata program id
    #[account(address = TOKEN_METADATA_PROGRAM)]
    pub token_metadata_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn set_token_metadata_handler(
    ctx: Context<SetTokenMetadata>,
    _id: u64,
    uri: String,
    is_mutable: bool,
) -> Result<()> {
    require!(
        !uri.is_empty() && uri.len() <= MAX_URI_LEN,
        MagicPadError::BadMetadata
    );

    let mint_key = ctx.accounts.mint.key();
    let (expected, _) = Pubkey::find_program_address(
        &[
            b"metadata",
            TOKEN_METADATA_PROGRAM.as_ref(),
            mint_key.as_ref(),
        ],
        &TOKEN_METADATA_PROGRAM,
    );
    require!(
        ctx.accounts.metadata.key() == expected,
        MagicPadError::BadMetadata
    );

    // CreateMetadataAccountV3: u8 disc=33, DataV2{name,symbol,uri,u16 fee,
    // 3x Option=None}, bool is_mutable, Option<CollectionDetails>=None
    let name = &ctx.accounts.launch.name;
    let symbol = &ctx.accounts.launch.symbol;
    let mut data = Vec::with_capacity(1 + 4 * 3 + name.len() + symbol.len() + uri.len() + 2 + 5);
    data.push(33u8);
    for s in [name.as_str(), symbol.as_str(), uri.as_str()] {
        data.extend_from_slice(&(s.len() as u32).to_le_bytes());
        data.extend_from_slice(s.as_bytes());
    }
    data.extend_from_slice(&0u16.to_le_bytes()); // seller_fee_basis_points
    data.extend_from_slice(&[0, 0, 0]); // creators / collection / uses = None
    data.push(is_mutable as u8);
    data.push(0); // collection_details = None

    let ix = Instruction {
        program_id: TOKEN_METADATA_PROGRAM,
        accounts: vec![
            AccountMeta::new(ctx.accounts.metadata.key(), false),
            AccountMeta::new_readonly(mint_key, false),
            AccountMeta::new_readonly(ctx.accounts.platform.key(), true), // mint authority (PDA)
            AccountMeta::new(ctx.accounts.admin.key(), true),             // payer
            AccountMeta::new_readonly(ctx.accounts.platform.key(), false), // update authority
            AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.rent.key(), false),
        ],
        data,
    };
    let bump = [ctx.accounts.platform.bump];
    let seeds: &[&[u8]] = &[PLATFORM_SEED, &bump];
    invoke_signed(
        &ix,
        &[
            ctx.accounts.metadata.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.platform.to_account_info(),
            ctx.accounts.admin.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.rent.to_account_info(),
        ],
        &[seeds],
    )?;
    Ok(())
}
