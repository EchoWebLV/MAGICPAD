//! Session-key rotation: a session is welded to whichever browser minted its
//! throwaway key, so a second browser (or a wiped localStorage) bounces every
//! trade with SessionKeyMismatch. The wallet itself can re-point the session.
//! Pinned down here: the swap takes effect (old key dies, new key trades),
//! only the trader can swap, and the ledger doesn't move a number.
mod common;
use common::*;
use solana_signer::Signer;

const DEP: u64 = 50_000_000; // 0.05 SOL opening deposit

#[test]
fn rotate_swaps_the_key_and_keeps_the_ledger() {
    let mut svm = fresh_svm();
    let t = setup_table(&mut svm);
    warp_past_window(&mut svm);
    let alice = t.alice.pubkey();
    send(
        &mut svm,
        &t.alice,
        &[],
        &[open_trade_session_ix(&alice, 0, &t.ka.pubkey(), DEP)],
    )
    .unwrap();
    send(&mut svm, &t.alice, &[&t.ka], &[buy_ix(&t.ka.pubkey(), &alice, 0, DEP / 2)]).unwrap();
    let before = read_session(&svm, 0, &alice);

    // the wallet re-points the session at a fresh key
    send(
        &mut svm,
        &t.alice,
        &[],
        &[rotate_session_key_ix(&alice, &alice, 0, &t.kb.pubkey())],
    )
    .unwrap();
    let s = read_session(&svm, 0, &alice);
    assert_eq!(s.session_key, t.kb.pubkey().to_bytes());
    // rotation touches the key and NOTHING else
    assert_eq!(s.deposit, before.deposit);
    assert_eq!(s.sol_spent, before.sol_spent);
    assert_eq!(s.tokens_held, before.tokens_held);

    // the old key is dead; the new key trades on the same ledger
    assert_pad_error(
        send(&mut svm, &t.alice, &[&t.ka], &[buy_ix(&t.ka.pubkey(), &alice, 0, DEP / 4)]),
        E_SESSION_KEY_MISMATCH,
        "old key after rotate",
    );
    send(&mut svm, &t.alice, &[&t.kb], &[buy_ix(&t.kb.pubkey(), &alice, 0, DEP / 4)]).unwrap();
    let s = read_session(&svm, 0, &alice);
    assert_eq!(s.sol_spent, DEP / 2 + DEP / 4);
}

#[test]
fn rotate_is_trader_gated() {
    let mut svm = fresh_svm();
    let t = setup_table(&mut svm);
    warp_past_window(&mut svm);
    let alice = t.alice.pubkey();
    send(
        &mut svm,
        &t.alice,
        &[],
        &[open_trade_session_ix(&alice, 0, &t.ka.pubkey(), DEP)],
    )
    .unwrap();

    // bob signs, aiming at alice's session — a session-theft attempt
    assert_pad_error(
        send(
            &mut svm,
            &t.bob,
            &[],
            &[rotate_session_key_ix(&t.bob.pubkey(), &alice, 0, &t.kb.pubkey())],
        ),
        E_UNAUTHORIZED,
        "stranger rotating someone else's session",
    );

    // the zero key is not a key
    assert_pad_error(
        send(
            &mut svm,
            &t.alice,
            &[],
            &[rotate_session_key_ix(&alice, &alice, 0, &system_id())],
        ),
        E_SESSION_KEY_MISMATCH,
        "rotate to the default pubkey",
    );

    // and the registered key still works untouched
    send(&mut svm, &t.alice, &[&t.ka], &[buy_ix(&t.ka.pubkey(), &alice, 0, DEP)]).unwrap();
}
