//! Launch fee + graduation tax live on the config PDA. Default 0/0.

mod common;
use common::*;
use solana_signer::Signer;

#[test]
fn default_launch_is_free() {
    let mut svm = fresh_svm();
    let t = setup_table(&mut svm);
    let cfg: ConfigMirror = read_account(&svm, &config_pda());
    assert_eq!(cfg.launch_fee_lamports, 0);
    assert_eq!(cfg.launch_tax_bps, 0);

    let before = lamports(&svm, &platform_pda());
    send(
        &mut svm,
        &t.alice,
        &[],
        &[create_launch_ix(&t.alice.pubkey(), 1, "FREE", "FREE")],
    )
    .unwrap();
    assert_eq!(lamports(&svm, &platform_pda()), before, "no fee moved");
}

#[test]
fn set_fees_then_launch_pays() {
    let mut svm = fresh_svm();
    let t = setup_table(&mut svm);
    send(&mut svm, &t.admin, &[], &[set_fees_ix(&t.admin.pubkey(), LAMPORTS_PER_SOL, 0)]).unwrap();
    let cfg: ConfigMirror = read_account(&svm, &config_pda());
    assert_eq!(cfg.launch_fee_lamports, LAMPORTS_PER_SOL);

    let before = lamports(&svm, &platform_pda());
    send(
        &mut svm,
        &t.alice,
        &[],
        &[create_launch_ix(&t.alice.pubkey(), 1, "PAID", "PAID")],
    )
    .unwrap();
    assert_eq!(lamports(&svm, &platform_pda()) - before, LAMPORTS_PER_SOL);

    send(&mut svm, &t.admin, &[], &[withdraw_platform_ix(&t.admin.pubkey(), 0)]).unwrap();
    assert_eq!(
        lamports(&svm, &platform_pda()),
        before,
        "withdraw returns the platform to rent-only",
    );
}

#[test]
fn tax_too_high_rejected() {
    let mut svm = fresh_svm();
    let t = setup_table(&mut svm);
    assert_pad_error(
        send(&mut svm, &t.alice, &[], &[set_fees_ix(&t.alice.pubkey(), 0, 0)]),
        E_UNAUTHORIZED,
        "set_fees not admin",
    );
    assert_pad_error(
        send(&mut svm, &t.admin, &[], &[set_fees_ix(&t.admin.pubkey(), 0, 10_001)]),
        E_TAX_TOO_HIGH,
        "tax > 10000 bps",
    );
}

#[test]
fn launch_tax_splits_raised_at_graduate() {
    let mut svm = fresh_svm();
    let t = setup_table(&mut svm);
    warp_past_window(&mut svm);
    // 10% of raised SOL to the platform
    send(&mut svm, &t.admin, &[], &[set_fees_ix(&t.admin.pubkey(), 0, 1_000)]).unwrap();

    send(
        &mut svm,
        &t.alice,
        &[],
        &[open_trade_session_ix(&t.alice.pubkey(), 0, &t.ka.pubkey(), 6 * LAMPORTS_PER_SOL)],
    )
    .unwrap();
    send(
        &mut svm,
        &t.cranker,
        &[&t.ka],
        &[buy_ix(&t.ka.pubkey(), &t.alice.pubkey(), 0, 5 * LAMPORTS_PER_SOL)],
    )
    .unwrap();
    assert_eq!(read_launch(&svm, 0).state, FROZEN);

    send(&mut svm, &t.cranker, &[], &[reconcile_ix(&t.alice.pubkey(), 0)]).unwrap();
    send(&mut svm, &t.cranker, &[], &[claim_tokens_ix(&t.cranker.pubkey(), &t.alice.pubkey(), 0)]).unwrap();

    let raised = read_launch(&svm, 0).real_sol_raised;
    assert!(raised >= GRADUATION_LAMPORTS);
    let tax = raised / 10;

    let plat_before = lamports(&svm, &platform_pda());
    send(&mut svm, &t.admin, &[], &[graduate_ix(&t.admin.pubkey(), 0)]).unwrap();
    assert_eq!(lamports(&svm, &platform_pda()) - plat_before, tax, "tax to platform");
}
