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

// ---- the 1 SOL line -------------------------------------------------------

#[test]
fn pump_buy_freezes_at_one_sol() {
    let mut svm = fresh_svm();
    let t = setup_table(&mut svm);
    send(&mut svm, &t.creator, &[], &[enable_pump_ix(&t.creator.pubkey(), 0)]).unwrap();
    send(
        &mut svm,
        &t.alice,
        &[],
        &[open_trade_session_ix(&t.alice.pubkey(), 0, &t.ka.pubkey(), 2 * LAMPORTS_PER_SOL)],
    )
    .unwrap();
    // 0.9 SOL: still bonding
    send(&mut svm, &t.cranker, &[&t.ka], &[buy_ix_pump(&t.ka.pubkey(), &t.alice.pubkey(), 0, 900_000_000)]).unwrap();
    assert_eq!(read_launch(&svm, 0).state, BONDING);
    // +0.2 SOL crosses 1 SOL → FROZEN
    send(&mut svm, &t.cranker, &[&t.ka], &[buy_ix_pump(&t.ka.pubkey(), &t.alice.pubkey(), 0, 200_000_000)]).unwrap();
    let l = read_launch(&svm, 0);
    assert!(l.real_sol_raised >= PUMP_GRADUATION_LAMPORTS, "raised {}", l.real_sol_raised);
    assert!(l.real_sol_raised < GRADUATION_LAMPORTS);
    assert_eq!(l.state, FROZEN);
    assert_eq!(l.sessions_opened, 1);
}

#[test]
fn buy_without_the_marker_account_keeps_the_85_sol_line() {
    // documents the edge: a client that omits the optional account on a pump
    // launch trades against the 85 SOL line. Recovery is admin freeze_launch.
    let mut svm = fresh_svm();
    let t = setup_table(&mut svm);
    send(&mut svm, &t.creator, &[], &[enable_pump_ix(&t.creator.pubkey(), 0)]).unwrap();
    send(
        &mut svm,
        &t.alice,
        &[],
        &[open_trade_session_ix(&t.alice.pubkey(), 0, &t.ka.pubkey(), 2 * LAMPORTS_PER_SOL)],
    )
    .unwrap();
    send(&mut svm, &t.cranker, &[&t.ka], &[buy_ix(&t.ka.pubkey(), &t.alice.pubkey(), 0, 1_500_000_000)]).unwrap();
    let l = read_launch(&svm, 0);
    assert!(l.real_sol_raised >= PUMP_GRADUATION_LAMPORTS);
    assert_eq!(l.state, BONDING, "no marker in the tx → no 1 SOL line");
    send(&mut svm, &t.admin, &[], &[freeze_launch_ix(&t.admin.pubkey(), 0)]).unwrap();
    assert_eq!(read_launch(&svm, 0).state, FROZEN);
}

#[test]
fn non_pump_launch_ignores_a_missing_marker() {
    // Option<Account> only resolves to None on true omission (a shorter
    // account list under allow-missing-optionals) or the program-id
    // sentinel — never merely because the PDA is uninitialized (verified
    // against anchor-lang 1.0.2's Option<T>::try_accounts). So a client that
    // never enabled pump mode and simply omits the trailing account (the
    // ordinary buy_ix, same as every non-pump caller elsewhere in this
    // suite) keeps the 85 SOL line — that's the "missing marker" case.
    let mut svm = fresh_svm();
    let t = setup_table(&mut svm);
    send(
        &mut svm,
        &t.alice,
        &[],
        &[open_trade_session_ix(&t.alice.pubkey(), 0, &t.ka.pubkey(), 2 * LAMPORTS_PER_SOL)],
    )
    .unwrap();
    send(&mut svm, &t.cranker, &[&t.ka], &[buy_ix(&t.ka.pubkey(), &t.alice.pubkey(), 0, 1_500_000_000)]).unwrap();
    assert_eq!(read_launch(&svm, 0).state, BONDING);

    // The converse edge, documented rather than silently dropped: passing
    // the pump PDA's *address* (not omitting it) when that PDA was never
    // created does NOT gracefully degrade to None — Anchor treats a
    // present-but-uninitialized account as `Some` and fails deserializing
    // it. A client must omit the account outright, not send a dead one.
    send(
        &mut svm,
        &t.bob,
        &[],
        &[open_trade_session_ix(&t.bob.pubkey(), 0, &t.kb.pubkey(), LAMPORTS_PER_SOL)],
    )
    .unwrap();
    let res = send(&mut svm, &t.cranker, &[&t.kb], &[buy_ix_pump(&t.kb.pubkey(), &t.bob.pubkey(), 0, 100_000_000)]);
    assert_anchor_error(res, 3012, "an uninitialized pump PDA is Some, not None (AccountNotInitialized)");
}

#[test]
fn pump_marker_of_another_launch_is_rejected() {
    // the security property is the seeds binding, not merely is_some(): a
    // real, initialized pump marker that belongs to a DIFFERENT launch must
    // still be rejected.
    let mut svm = fresh_svm();
    let t = setup_table(&mut svm);
    send(&mut svm, &t.creator, &[], &[create_launch_fair_ix(&t.creator.pubkey(), 1, "FAIREST", "FAIR")]).unwrap();
    send(&mut svm, &t.creator, &[], &[enable_pump_ix(&t.creator.pubkey(), 1)]).unwrap();
    send(
        &mut svm,
        &t.alice,
        &[],
        &[open_trade_session_ix(&t.alice.pubkey(), 0, &t.ka.pubkey(), 2 * LAMPORTS_PER_SOL)],
    )
    .unwrap();
    let res = send(
        &mut svm,
        &t.cranker,
        &[&t.ka],
        &[buy_ix_trailing(&t.ka.pubkey(), &t.alice.pubkey(), 0, 100_000_000, &pump_pda(1))],
    );
    assert_anchor_error(res, 2006, "a marker for another launch fails the seeds constraint");
}

#[test]
fn program_id_sentinel_means_no_marker() {
    // the program id is the sentinel Anchor's JS client emits for `pump:
    // null`; it reads as None → 85 SOL line.
    let mut svm = fresh_svm();
    let t = setup_table(&mut svm);
    send(&mut svm, &t.creator, &[], &[enable_pump_ix(&t.creator.pubkey(), 0)]).unwrap();
    send(
        &mut svm,
        &t.alice,
        &[],
        &[open_trade_session_ix(&t.alice.pubkey(), 0, &t.ka.pubkey(), 2 * LAMPORTS_PER_SOL)],
    )
    .unwrap();
    send(
        &mut svm,
        &t.cranker,
        &[&t.ka],
        &[buy_ix_trailing(&t.ka.pubkey(), &t.alice.pubkey(), 0, 1_500_000_000, &program_id())],
    )
    .unwrap();
    let l = read_launch(&svm, 0);
    assert!(l.real_sol_raised >= PUMP_GRADUATION_LAMPORTS);
    assert_eq!(l.state, BONDING, "program-id sentinel reads as None → 85 SOL line");
}

#[test]
fn a_marker_carrying_buy_heals_a_drifted_pump_launch() {
    // the drift (buy_without_the_marker_account_keeps_the_85_sol_line) closes
    // as soon as any marker-carrying buy lands, without admin action.
    let mut svm = fresh_svm();
    let t = setup_table(&mut svm);
    send(&mut svm, &t.creator, &[], &[enable_pump_ix(&t.creator.pubkey(), 0)]).unwrap();
    send(
        &mut svm,
        &t.alice,
        &[],
        &[open_trade_session_ix(&t.alice.pubkey(), 0, &t.ka.pubkey(), 2 * LAMPORTS_PER_SOL)],
    )
    .unwrap();
    send(&mut svm, &t.cranker, &[&t.ka], &[buy_ix(&t.ka.pubkey(), &t.alice.pubkey(), 0, 1_500_000_000)]).unwrap();
    assert_eq!(read_launch(&svm, 0).state, BONDING);
    send(&mut svm, &t.cranker, &[&t.ka], &[buy_ix_pump(&t.ka.pubkey(), &t.alice.pubkey(), 0, 100_000_000)]).unwrap();
    assert_eq!(read_launch(&svm, 0).state, FROZEN);
}

#[test]
fn pump_line_is_inclusive() {
    // >=, exercised at equality.
    let mut svm = fresh_svm();
    let t = setup_table(&mut svm);
    send(&mut svm, &t.creator, &[], &[enable_pump_ix(&t.creator.pubkey(), 0)]).unwrap();
    send(
        &mut svm,
        &t.alice,
        &[],
        &[open_trade_session_ix(&t.alice.pubkey(), 0, &t.ka.pubkey(), 2 * LAMPORTS_PER_SOL)],
    )
    .unwrap();
    send(&mut svm, &t.cranker, &[&t.ka], &[buy_ix_pump(&t.ka.pubkey(), &t.alice.pubkey(), 0, 900_000_000)]).unwrap();
    assert_eq!(read_launch(&svm, 0).state, BONDING);
    send(&mut svm, &t.cranker, &[&t.ka], &[buy_ix_pump(&t.ka.pubkey(), &t.alice.pubkey(), 0, 100_000_000)]).unwrap();
    let l = read_launch(&svm, 0);
    assert_eq!(l.real_sol_raised, PUMP_GRADUATION_LAMPORTS);
    assert_eq!(l.state, FROZEN);
}

// ---- set_pump_mint --------------------------------------------------------

/// enable pump, alice (2 SOL deposit) crosses the 1 SOL line (the buy froze
/// it, not an admin action). Returns the table.
fn frozen_pump_launch(svm: &mut litesvm::LiteSVM, px: &PumpFixtures) -> Table {
    let t = setup_pump_table(svm, px);
    send(svm, &t.creator, &[], &[enable_pump_ix(&t.creator.pubkey(), 0)]).unwrap();
    send(
        svm,
        &t.alice,
        &[],
        &[open_trade_session_ix(&t.alice.pubkey(), 0, &t.ka.pubkey(), 2 * LAMPORTS_PER_SOL)],
    )
    .unwrap();
    send(svm, &t.cranker, &[&t.ka], &[buy_ix_pump(&t.ka.pubkey(), &t.alice.pubkey(), 0, 1_100_000_000)]).unwrap();
    assert_eq!(read_launch(svm, 0).state, FROZEN);
    t
}

#[test]
fn set_pump_mint_records_the_curve_mint() {
    let mut svm = fresh_svm();
    let Some(px) = load_pump(&mut svm) else { return };
    let t = frozen_pump_launch(&mut svm, &px);
    send(
        &mut svm,
        &t.admin,
        &[],
        &[set_pump_mint_ix(&t.admin.pubkey(), 0, &px.mint, &px.bonding_curve)],
    )
    .unwrap();
    assert_eq!(read_pump(&svm, 0).pump_mint, px.mint.to_bytes());
}

#[test]
fn set_pump_mint_rejects_wrong_creator_curve() {
    // an ordinary table: launch.creator != the fixture curve's creator
    let mut svm = fresh_svm();
    let Some(px) = load_pump(&mut svm) else { return };
    let t = setup_table(&mut svm);
    send(&mut svm, &t.creator, &[], &[enable_pump_ix(&t.creator.pubkey(), 0)]).unwrap();
    send(
        &mut svm,
        &t.alice,
        &[],
        &[open_trade_session_ix(&t.alice.pubkey(), 0, &t.ka.pubkey(), 2 * LAMPORTS_PER_SOL)],
    )
    .unwrap();
    send(&mut svm, &t.cranker, &[&t.ka], &[buy_ix_pump(&t.ka.pubkey(), &t.alice.pubkey(), 0, 1_100_000_000)]).unwrap();
    let res = send(
        &mut svm,
        &t.admin,
        &[],
        &[set_pump_mint_ix(&t.admin.pubkey(), 0, &px.mint, &px.bonding_curve)],
    );
    assert_pad_error(res, E_BAD_PUMP_ACCOUNT, "curve creator != launch creator");
}

#[test]
fn set_pump_mint_rejects_bonding_launch_non_admin_and_repeat() {
    let mut svm = fresh_svm();
    let Some(px) = load_pump(&mut svm) else { return };
    let t = setup_pump_table(&mut svm, &px);
    send(&mut svm, &t.creator, &[], &[enable_pump_ix(&t.creator.pubkey(), 0)]).unwrap();
    // still BONDING
    let res = send(
        &mut svm,
        &t.admin,
        &[],
        &[set_pump_mint_ix(&t.admin.pubkey(), 0, &px.mint, &px.bonding_curve)],
    );
    assert_pad_error(res, E_LAUNCH_NOT_FROZEN, "bonding launch");
    send(
        &mut svm,
        &t.alice,
        &[],
        &[open_trade_session_ix(&t.alice.pubkey(), 0, &t.ka.pubkey(), 2 * LAMPORTS_PER_SOL)],
    )
    .unwrap();
    send(&mut svm, &t.cranker, &[&t.ka], &[buy_ix_pump(&t.ka.pubkey(), &t.alice.pubkey(), 0, 1_100_000_000)]).unwrap();
    // non-admin
    let res = send(
        &mut svm,
        &t.alice,
        &[],
        &[set_pump_mint_ix(&t.alice.pubkey(), 0, &px.mint, &px.bonding_curve)],
    );
    assert_pad_error(res, E_UNAUTHORIZED, "alice is not admin");
    send(
        &mut svm,
        &t.admin,
        &[],
        &[set_pump_mint_ix(&t.admin.pubkey(), 0, &px.mint, &px.bonding_curve)],
    )
    .unwrap();
    svm.expire_blockhash();
    let res = send(
        &mut svm,
        &t.admin,
        &[],
        &[set_pump_mint_ix(&t.admin.pubkey(), 0, &px.mint, &px.bonding_curve)],
    );
    assert_pad_error(res, E_PUMP_MINT_ALREADY_SET, "second set");
}

#[test]
fn set_pump_mint_rejects_a_curve_that_is_not_pumps() {
    let mut svm = fresh_svm();
    let Some(px) = load_pump(&mut svm) else { return };
    let t = frozen_pump_launch(&mut svm, &px);
    // the right derivation but a system-owned account: fails the owner check
    let fake_mint = Keypair::new().pubkey();
    let fake_curve = bonding_curve_pda(&fake_mint);
    svm.airdrop(&fake_curve, LAMPORTS_PER_SOL).unwrap();
    let res = send(
        &mut svm,
        &t.admin,
        &[],
        &[set_pump_mint_ix(&t.admin.pubkey(), 0, &fake_mint, &fake_curve)],
    );
    assert_pad_error(res, E_BAD_PUMP_ACCOUNT, "system-owned curve");
    // the real curve under the wrong mint: fails the address check
    let res = send(
        &mut svm,
        &t.admin,
        &[],
        &[set_pump_mint_ix(&t.admin.pubkey(), 0, &fake_mint, &px.bonding_curve)],
    );
    assert_pad_error(res, E_BAD_PUMP_ACCOUNT, "curve address != derivation for mint");
}
