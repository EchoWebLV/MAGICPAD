use anchor_lang::prelude::*;

// Append-only: tests assert raw error indexes (stakehouse rule).
#[error_code]
pub enum MagicPadError {
    #[msg("launch is not bonding")]
    LaunchNotBonding, // 6000
    #[msg("launch is not frozen")]
    LaunchNotFrozen, // 6001
    #[msg("deposit below the minimum")]
    DepositTooSmall, // 6002
    #[msg("net exposure would exceed the escrowed deposit")]
    ExceedsDeposit, // 6003
    #[msg("not enough tokens held")]
    InsufficientTokens, // 6004
    #[msg("first-window buy cap exceeded")]
    FirstWindowCap, // 6005
    #[msg("launch has not reached graduation")]
    NotGraduatable, // 6006
    #[msg("session already reconciled")]
    AlreadyReconciled, // 6007
    #[msg("session not reconciled yet")]
    NotReconciled, // 6008
    #[msg("already claimed")]
    AlreadyClaimed, // 6009
    #[msg("signer is not the session key")]
    SessionKeyMismatch, // 6010
    #[msg("curve quote failed")]
    BadQuote, // 6011
    #[msg("nothing to claim")]
    NothingToClaim, // 6012
    #[msg("arithmetic overflow")]
    Overflow, // 6013
    #[msg("bad name or symbol")]
    BadMetadata, // 6014
    #[msg("unauthorized")]
    Unauthorized, // 6015
    #[msg("wrong launch for this account")]
    WrongLaunch, // 6016
    #[msg("pot not funded yet — retry after loser sessions reconcile")]
    PotNotReady, // 6017
}
