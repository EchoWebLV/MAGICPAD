//! Gate for the whole pump plan: the mainnet pump.fun ELF must execute
//! under litesvm, a plain keypair must be able to `buy` into ANOTHER
//! wallet's ATA, and close_user_volume_accumulator must refund the user.
mod common;
use common::pump::*;
use common::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

#[test]
fn pump_pdas_match_mainnet() {
    assert_eq!(global_pda().to_string(), "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf");
    assert_eq!(gva_pda().to_string(), "Hq2wp8uJ9jCPsYgNHex8RtqdvMPfVGoYwjvF1ATiwn2Y");
    assert_eq!(event_authority().to_string(), "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1");
    assert_eq!(fee_config_pda().to_string(), "8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt");
}

#[test]
fn pump_buy_lands_in_a_foreign_ata_and_uva_closes() {
    let mut svm = fresh_svm();
    let Some(px) = load_pump(&mut svm) else { return };

    let user = Keypair::new();
    let holder = Keypair::new();
    svm.airdrop(&user.pubkey(), 5 * LAMPORTS_PER_SOL).unwrap();

    let before = read_bonding_curve(&svm, &px.mint);
    assert!(!before.complete);
    assert_eq!(before.creator, px.creator.pubkey());
    let bc_lamports_before = lamports(&svm, &px.bonding_curve);

    let amount = 1_000_000_000_000u64; // 1M tokens (6 decimals)
    let max_sol_cost = 100_000_000u64; // 0.1 SOL cap — a fresh curve fills this for ~0.028
    send(
        &mut svm,
        &user,
        &[],
        &[
            create_ata_idempotent_ix(&user.pubkey(), &holder.pubkey(), &px.mint),
            pump_buy_ix(
                &user.pubkey(),
                &px.mint,
                &px.creator.pubkey(),
                &holder.pubkey(),
                amount,
                max_sol_cost,
                &px.fee_recipient,
                &px.buyback,
            ),
        ],
    )
    .unwrap();

    let holder_ata = ata_address(&holder.pubkey(), &px.mint);
    assert_eq!(token_amount(&svm, &holder_ata), amount, "exact amount in the FOREIGN ata");
    let after = read_bonding_curve(&svm, &px.mint);
    assert_eq!(after.real_token_reserves, before.real_token_reserves - amount);
    assert!(lamports(&svm, &px.bonding_curve) > bc_lamports_before, "SOL entered the curve");

    // track_volume=true opened a user_volume_accumulator; closing refunds its rent
    let uva = uva_pda(&user.pubkey());
    assert!(lamports(&svm, &uva) > 0, "uva exists after the buy");
    let user_before = lamports(&svm, &user.pubkey());
    send(&mut svm, &user, &[], &[close_uva_ix(&user.pubkey())]).unwrap();
    assert_eq!(lamports(&svm, &uva), 0, "uva closed");
    assert!(lamports(&svm, &user.pubkey()) > user_before, "rent came back (minus the tx fee)");
}
