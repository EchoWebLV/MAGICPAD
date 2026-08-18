use anchor_lang::prelude::*;

pub mod constants;
pub mod curve;
pub mod error;
pub mod state;

declare_id!("27HH4WUhKMmkza5NTpAjwhHkRwiPotPw55HxvjDRDsws");

#[program]
pub mod magicpad {
    use super::*;
}
