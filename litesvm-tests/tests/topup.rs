//! The top-up rail: escrow that grows mid-session. In litesvm the delegation
//! transport doesn't exist, so the L1 and ER lanes run as plain program ixs —
//! same ledger logic, same lamport flows, and absorb's typed-account gate is
//! trivially open (nothing is ever DLP-owned here). What these tests pin down
//! is the MONEY: the ceiling moves exactly by the applied amount, reconcile
//! refuses to fire until applied notes are absorbed, and unapplied notes
//! refund to the lamport.
mod common;
use common::*;
use solana_signer::Signer;

const DEP: u64 = 50_000_000; // 0.05 SOL opening deposit
const TOP: u64 = 100_000_000; // 0.1 SOL top-up

/// open a session for alice past the anti-snipe window, buy the deposit full
fn table_at_ceiling(svm: &mut litesvm::LiteSVM) -> Table {
    let t = setup_table(svm);
    warp_past_window(svm);
    send(
        svm,
        &t.alice,
        &[],
        &[open_trade_session_ix(&t.alice.pubkey(), 0, &t.ka.pubkey(), DEP)],
    )
    .unwrap();
    send(svm, &t.alice, &[&t.ka], &[buy_ix(&t.ka.pubkey(), &t.alice.pubkey(), 0, DEP)]).unwrap();
    t
}

#[test]
fn topup_moves_the_ceiling() {
    let mut svm = fresh_svm();
    let t = table_at_ceiling(&mut svm);
    let alice = t.alice.pubkey();

    // the wall: one more lamport of exposure is over the deposit
    assert_pad_error(
        send(&mut svm, &t.alice, &[&t.ka], &[buy_ix(&t.ka.pubkey(), &alice, 0, MIN_DEPOSIT)]),
        E_EXCEEDS_DEPOSIT,
        "buy past deposit",
    );

    // top up + apply — the ceiling moves
    send(&mut svm, &t.alice, &[], &[top_up_session_ix(&alice, 0, 1, TOP)]).unwrap();
    let note: TopUpMirror = read_account(&svm, &topup_pda(0, &alice, 1));
    assert_eq!(note.amount, TOP);
    assert!(!note.applied);
    assert_eq!(lamports(&svm, &topup_pda(0, &alice, 1)) > TOP, true); // rent + escrow

    send(&mut svm, &t.alice, &[&t.ka], &[apply_top_up_ix(&t.ka.pubkey(), &alice, 0, 1)]).unwrap();
    let s = read_session(&svm, 0, &alice);
    assert_eq!(s.deposit, DEP + TOP);
    let note: TopUpMirror = read_account(&svm, &topup_pda(0, &alice, 1));
    assert!(note.applied);

    // the exact buy that failed now clears, and a second one fills the new room
    send(&mut svm, &t.alice, &[&t.ka], &[buy_ix(&t.ka.pubkey(), &alice, 0, MIN_DEPOSIT)]).unwrap();
    send(
        &mut svm,
        &t.alice,
        &[&t.ka],
        &[buy_ix(&t.ka.pubkey(), &alice, 0, TOP - MIN_DEPOSIT)],
    )
    .unwrap();
    let s = read_session(&svm, 0, &alice);
    assert_eq!(s.sol_spent, DEP + TOP);

    // and the wall is exactly where the new ceiling says
    assert_pad_error(
        send(&mut svm, &t.alice, &[&t.ka], &[buy_ix(&t.ka.pubkey(), &alice, 0, 1)]),
        E_EXCEEDS_DEPOSIT,
        "buy past raised deposit",
    );
}

#[test]
fn reconcile_waits_for_absorb_then_conserves() {
    let mut svm = fresh_svm();
    let t = table_at_ceiling(&mut svm);
    let alice = t.alice.pubkey();

    send(&mut svm, &t.alice, &[], &[top_up_session_ix(&alice, 0, 7, TOP)]).unwrap();
    send(&mut svm, &t.alice, &[&t.ka], &[apply_top_up_ix(&t.ka.pubkey(), &alice, 0, 7)]).unwrap();
    send(&mut svm, &t.alice, &[&t.ka], &[buy_ix(&t.ka.pubkey(), &alice, 0, TOP)]).unwrap();

    send(&mut svm, &t.admin, &[], &[freeze_launch_ix(&t.admin.pubkey(), 0)]).unwrap();

    // reconcile CANNOT fire while the applied note's lamports are outside
    // the session PDA — the rent+deposit coverage check refuses
    assert_pad_error(
        send(&mut svm, &t.cranker, &[], &[reconcile_ix(&alice, 0)]),
        E_OVERFLOW,
        "reconcile before absorb",
    );

    let wallet_before = lamports(&svm, &alice);
    let session_before = lamports(&svm, &session_pda(0, &alice));
    let note_rent = lamports(&svm, &topup_pda(0, &alice, 7)) - TOP;

    send(&mut svm, &t.cranker, &[], &[absorb_top_up_ix(&alice, 0, 7)]).unwrap();
    // escrow folded in, note gone, rent walked home to the trader
    assert_eq!(lamports(&svm, &session_pda(0, &alice)), session_before + TOP);
    assert_eq!(svm.get_account(&topup_pda(0, &alice, 7)).map(|a| a.lamports).unwrap_or(0), 0);
    assert_eq!(lamports(&svm, &alice), wallet_before + note_rent);

    // now reconcile lands: net loser of the full DEP+TOP, all of it to the pot
    let launch_before = lamports(&svm, &launch_pda(0));
    send(&mut svm, &t.cranker, &[], &[reconcile_ix(&alice, 0)]).unwrap();
    let s = read_session(&svm, 0, &alice);
    assert!(s.reconciled);
    assert_eq!(s.deposit, DEP + TOP);
    assert_eq!(s.sol_spent, DEP + TOP);
    assert_eq!(lamports(&svm, &launch_pda(0)), launch_before + DEP + TOP);
    // spent everything, nothing walks home
    assert_eq!(lamports(&svm, &alice), wallet_before + note_rent);
}

#[test]
fn unapplied_note_refunds_in_full() {
    let mut svm = fresh_svm();
    let t = table_at_ceiling(&mut svm);
    let alice = t.alice.pubkey();

    let wallet_before = lamports(&svm, &alice);
    send(&mut svm, &t.alice, &[], &[top_up_session_ix(&alice, 0, 2, TOP)]).unwrap();
    // never applied — the market freezes first
    send(&mut svm, &t.admin, &[], &[freeze_launch_ix(&t.admin.pubkey(), 0)]).unwrap();

    send(&mut svm, &t.cranker, &[], &[absorb_top_up_ix(&alice, 0, 2)]).unwrap();
    // every lamport home: escrow + rent (tx fees were paid by alice herself)
    let fee = 5000; // one signature on the top_up tx
    assert_eq!(lamports(&svm, &alice), wallet_before - fee);
    assert_eq!(svm.get_account(&topup_pda(0, &alice, 2)).map(|a| a.lamports).unwrap_or(0), 0);

    // the ledger never grew, reconcile sees the original deposit only
    let s = read_session(&svm, 0, &alice);
    assert_eq!(s.deposit, DEP);
    send(&mut svm, &t.cranker, &[], &[reconcile_ix(&alice, 0)]).unwrap();
}

#[test]
fn double_apply_rejected() {
    let mut svm = fresh_svm();
    let t = table_at_ceiling(&mut svm);
    let alice = t.alice.pubkey();

    send(&mut svm, &t.alice, &[], &[top_up_session_ix(&alice, 0, 3, TOP)]).unwrap();
    send(&mut svm, &t.alice, &[&t.ka], &[apply_top_up_ix(&t.ka.pubkey(), &alice, 0, 3)]).unwrap();
    assert_pad_error(
        send(&mut svm, &t.alice, &[&t.ka], &[apply_top_up_ix(&t.ka.pubkey(), &alice, 0, 3)]),
        E_ALREADY_APPLIED,
        "second apply",
    );
    // the ceiling grew exactly once
    assert_eq!(read_session(&svm, 0, &alice).deposit, DEP + TOP);
}

#[test]
fn apply_after_freeze_rejected() {
    let mut svm = fresh_svm();
    let t = table_at_ceiling(&mut svm);
    let alice = t.alice.pubkey();

    send(&mut svm, &t.alice, &[], &[top_up_session_ix(&alice, 0, 4, TOP)]).unwrap();
    send(&mut svm, &t.admin, &[], &[freeze_launch_ix(&t.admin.pubkey(), 0)]).unwrap();
    assert_pad_error(
        send(&mut svm, &t.alice, &[&t.ka], &[apply_top_up_ix(&t.ka.pubkey(), &alice, 0, 4)]),
        E_LAUNCH_NOT_BONDING,
        "apply after freeze",
    );
}

#[test]
fn topup_gates() {
    let mut svm = fresh_svm();
    let t = setup_table(&mut svm);
    warp_past_window(&mut svm);
    let alice = t.alice.pubkey();

    // no session yet — nothing to top up
    assert!(send(&mut svm, &t.alice, &[], &[top_up_session_ix(&alice, 0, 1, TOP)]).is_err());

    send(
        &mut svm,
        &t.alice,
        &[],
        &[open_trade_session_ix(&alice, 0, &t.ka.pubkey(), DEP)],
    )
    .unwrap();

    // dust top-up rejected
    assert_pad_error(
        send(&mut svm, &t.alice, &[], &[top_up_session_ix(&alice, 0, 1, MIN_DEPOSIT - 1)]),
        E_DEPOSIT_TOO_SMALL,
        "dust top-up",
    );

    // bob cannot apply alice's note onto his session (seeds bind trader)
    send(&mut svm, &t.alice, &[], &[top_up_session_ix(&alice, 0, 1, TOP)]).unwrap();
    send(
        &mut svm,
        &t.bob,
        &[],
        &[open_trade_session_ix(&t.bob.pubkey(), 0, &t.kb.pubkey(), DEP)],
    )
    .unwrap();
    assert!(send(
        &mut svm,
        &t.bob,
        &[&t.kb],
        &[apply_top_up_ix(&t.kb.pubkey(), &t.bob.pubkey(), 0, 1)]
    )
    .is_err());

    // a stranger's absorb still pays the TRADER, never the cranker
    send(&mut svm, &t.alice, &[&t.ka], &[apply_top_up_ix(&t.ka.pubkey(), &alice, 0, 1)]).unwrap();
    // ...but absorb with a spoofed trader account is rejected outright
    let mut spoofed = absorb_top_up_ix(&alice, 0, 1);
    spoofed.accounts[0].pubkey = t.cranker.pubkey();
    assert_pad_error(
        send(&mut svm, &t.cranker, &[], &[spoofed]),
        E_UNAUTHORIZED,
        "absorb to a stranger",
    );
}
