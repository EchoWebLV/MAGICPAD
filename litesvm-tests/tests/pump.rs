//! pump.fun mode: enable → 1 SOL line → set_pump_mint → pump_claim per
//! session → pump_graduate. Tests that touch the real pump program load
//! fixtures and return early when they are absent.
mod common;
use common::pump::*;
use common::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

// ---- enable_pump ----------------------------------------------------------

#[test]
fn enable_pump_creates_the_marker() {
    let mut svm = fresh_svm();
    let t = setup_table(&mut svm);
    assert_eq!(lamports(&svm, &pump_pda(0)), 0, "no marker before");
    send(&mut svm, &t.creator, &[], &[enable_pump_ix(&t.creator.pubkey(), 0)]).unwrap();
    let p = read_pump(&svm, 0);
    assert_eq!(p.launch_id, 0);
    assert_eq!(p.pump_mint, [0u8; 32], "unset until set_pump_mint");
    assert_eq!(p.claims_done, 0);
    assert!(lamports(&svm, &pump_pda(0)) > 0);
}

#[test]
fn enable_pump_rejects_non_creator() {
    let mut svm = fresh_svm();
    let t = setup_table(&mut svm);
    let res = send(&mut svm, &t.alice, &[], &[enable_pump_ix(&t.alice.pubkey(), 0)]);
    assert_pad_error(res, E_UNAUTHORIZED, "alice is not the creator");
}

#[test]
fn enable_pump_rejects_after_first_trade() {
    let mut svm = fresh_svm();
    let t = setup_table(&mut svm);
    send(
        &mut svm,
        &t.alice,
        &[],
        &[open_trade_session_ix(&t.alice.pubkey(), 0, &t.ka.pubkey(), LAMPORTS_PER_SOL)],
    )
    .unwrap();
    send(&mut svm, &t.cranker, &[&t.ka], &[buy_ix(&t.ka.pubkey(), &t.alice.pubkey(), 0, 100_000_000)]).unwrap();
    let res = send(&mut svm, &t.creator, &[], &[enable_pump_ix(&t.creator.pubkey(), 0)]);
    assert_pad_error(res, E_PUMP_TOO_LATE, "sol already raised");
}

#[test]
fn enable_pump_twice_fails() {
    let mut svm = fresh_svm();
    let t = setup_table(&mut svm);
    send(&mut svm, &t.creator, &[], &[enable_pump_ix(&t.creator.pubkey(), 0)]).unwrap();
    svm.expire_blockhash();
    let res = send(&mut svm, &t.creator, &[], &[enable_pump_ix(&t.creator.pubkey(), 0)]);
    assert!(res.is_err(), "init on an existing account must fail");
}

#[test]
fn enable_pump_allowed_after_session_open_before_any_buy() {
    // open_trade_session touches no Launch field: the curve is still unpriced,
    // so the creator may still pick the 1 SOL line with a deposit already escrowed
    let mut svm = fresh_svm();
    let t = setup_table(&mut svm);
    send(
        &mut svm,
        &t.alice,
        &[],
        &[open_trade_session_ix(&t.alice.pubkey(), 0, &t.ka.pubkey(), LAMPORTS_PER_SOL)],
    )
    .unwrap();
    send(&mut svm, &t.creator, &[], &[enable_pump_ix(&t.creator.pubkey(), 0)]).unwrap();
    assert_eq!(read_pump(&svm, 0).launch_id, 0);
}

#[test]
fn enable_pump_works_on_a_fair_launch() {
    // pump mode and fairest mode compose; enable reads nothing fair-specific
    let mut svm = fresh_svm();
    let t = setup_table(&mut svm);
    send(&mut svm, &t.creator, &[], &[create_launch_fair_ix(&t.creator.pubkey(), 1, "FAIREST", "FAIR")]).unwrap();
    send(&mut svm, &t.creator, &[], &[enable_pump_ix(&t.creator.pubkey(), 1)]).unwrap();
    assert!(read_launch(&svm, 1).flip_pot >= 0, "launch 1 must really be fairest (-1 = standard)");
    let p = read_pump(&svm, 1);
    assert_eq!(p.launch_id, 1);
    assert_eq!(p.pump_mint, [0u8; 32]);
}
