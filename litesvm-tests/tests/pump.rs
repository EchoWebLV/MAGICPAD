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

#[test]
fn set_pump_mint_rejects_a_completed_curve() {
    let mut svm = fresh_svm();
    let Some(px) = load_pump(&mut svm) else { return };
    let t = frozen_pump_launch(&mut svm, &px);
    // flip pump's `complete` flag (offset 48, see pump_cpi.rs) on the captured curve
    let mut acc = svm.get_account(&px.bonding_curve).expect("bonding curve");
    acc.data[48] = 1;
    svm.set_account(px.bonding_curve, acc).unwrap();
    let res = send(
        &mut svm,
        &t.admin,
        &[],
        &[set_pump_mint_ix(&t.admin.pubkey(), 0, &px.mint, &px.bonding_curve)],
    );
    assert_pad_error(res, E_BAD_PUMP_ACCOUNT, "curve already complete");
}

#[test]
fn set_pump_mint_accepts_a_reconciled_launch() {
    let mut svm = fresh_svm();
    let Some(px) = load_pump(&mut svm) else { return };
    let t = frozen_pump_launch(&mut svm, &px);
    // alice is the only session, so one reconcile completes the count
    send(&mut svm, &t.cranker, &[], &[reconcile_ix(&t.alice.pubkey(), 0)]).unwrap();
    assert_eq!(read_launch(&svm, 0).state, RECONCILED);
    send(
        &mut svm,
        &t.admin,
        &[],
        &[set_pump_mint_ix(&t.admin.pubkey(), 0, &px.mint, &px.bonding_curve)],
    )
    .unwrap();
    assert_eq!(read_pump(&svm, 0).pump_mint, px.mint.to_bytes());
}

// ---- pump_claim -----------------------------------------------------------

/// alice (1.2 SOL deposit) and bob (0.5 SOL deposit). bob buys 0.1 SOL and
/// sells everything (a loser with sol_spent > 0, tokens_held == 0); alice's
/// 1.1 SOL buy crosses the line (real_sol_raised += amount_in, trade.rs:123).
/// Both reconciled, pump mint set.
fn claim_ready(svm: &mut litesvm::LiteSVM, px: &PumpFixtures) -> (Table, PumpKeys) {
    let t = setup_pump_table(svm, px);
    send(svm, &t.creator, &[], &[enable_pump_ix(&t.creator.pubkey(), 0)]).unwrap();
    send(
        svm,
        &t.alice,
        &[],
        &[open_trade_session_ix(&t.alice.pubkey(), 0, &t.ka.pubkey(), 1_200_000_000)],
    )
    .unwrap();
    send(
        svm,
        &t.bob,
        &[],
        &[open_trade_session_ix(&t.bob.pubkey(), 0, &t.kb.pubkey(), 500_000_000)],
    )
    .unwrap();
    send(svm, &t.cranker, &[&t.kb], &[buy_ix_pump(&t.kb.pubkey(), &t.bob.pubkey(), 0, 100_000_000)]).unwrap();
    let held = read_session(svm, 0, &t.bob.pubkey()).tokens_held;
    send(svm, &t.cranker, &[&t.kb], &[sell_ix(&t.kb.pubkey(), &t.bob.pubkey(), 0, held)]).unwrap();
    assert_eq!(read_session(svm, 0, &t.bob.pubkey()).tokens_held, 0);
    send(svm, &t.cranker, &[&t.ka], &[buy_ix_pump(&t.ka.pubkey(), &t.alice.pubkey(), 0, 1_100_000_000)]).unwrap();
    assert_eq!(read_launch(svm, 0).state, FROZEN);
    assert_eq!(read_launch(svm, 0).sessions_opened, 2);
    // losers first, then the winner (same order the keeper uses)
    send(svm, &t.cranker, &[], &[reconcile_ix(&t.bob.pubkey(), 0)]).unwrap();
    send(svm, &t.cranker, &[], &[reconcile_ix(&t.alice.pubkey(), 0)]).unwrap();
    assert_eq!(read_launch(svm, 0).state, RECONCILED);
    send(
        svm,
        &t.admin,
        &[],
        &[set_pump_mint_ix(&t.admin.pubkey(), 0, &px.mint, &px.bonding_curve)],
    )
    .unwrap();
    let pk = PumpKeys::from(px);
    (t, pk)
}

fn ceiling_of(tokens_held: u64) -> u64 {
    tokens_held * (10_000 - PUMP_HAIRCUT_BPS) / 10_000
}

#[test]
fn pump_claim_buys_the_share_into_the_traders_ata() {
    let mut svm = fresh_svm();
    let Some(px) = load_pump(&mut svm) else { return };
    let (t, pk) = claim_ready(&mut svm, &px);
    let alice = t.alice.pubkey();
    let held = read_session(&svm, 0, &alice).tokens_held;
    assert!(held > 0);
    let amount = ceiling_of(held) / 2; // well inside the pot
    let ata = ata_address(&alice, &pk.mint);
    let vault = pump_vault_pda(0, &alice);
    let cv = creator_vault_pda(&pk.creator);

    let launch_before = lamports(&svm, &launch_pda(0));
    let bc_before = lamports(&svm, &px.bonding_curve);
    let fee_before = lamports(&svm, &pk.fee_recipient);
    let bb_before = lamports(&svm, &pk.buyback);
    let cv_before = lamports(&svm, &cv);
    let cranker_before = lamports(&svm, &t.cranker.pubkey());

    send(
        &mut svm,
        &t.cranker,
        &[],
        &[pump_claim_ix(&t.cranker.pubkey(), &alice, 0, &pk, amount, 700_000_000)],
    )
    .unwrap();

    assert_eq!(token_amount(&svm, &ata), amount, "exact amount in alice's ata");
    assert_eq!(lamports(&svm, &vault), 0, "vault swept back to the launch");
    assert_eq!(lamports(&svm, &uva_pda(&vault)), 0, "vault's volume accumulator closed");
    let s = read_session(&svm, 0, &alice);
    assert!(s.tokens_claimed);
    assert_eq!(read_pump(&svm, 0).claims_done, 1);
    // the launch paid exactly what left the system: curve + fees + creator vault + the ata's rent
    let spent = launch_before - lamports(&svm, &launch_pda(0));
    let landed = (lamports(&svm, &px.bonding_curve) - bc_before)
        + (lamports(&svm, &pk.fee_recipient) - fee_before)
        + (lamports(&svm, &pk.buyback) - bb_before)
        + (lamports(&svm, &cv) - cv_before)
        + lamports(&svm, &ata);
    assert_eq!(spent, landed, "lamport conservation");
    // the cranker only paid the tx fee
    assert!(cranker_before - lamports(&svm, &t.cranker.pubkey()) < 20_000);
}

#[test]
fn pump_claim_bookkeeping_for_a_flat_session() {
    let mut svm = fresh_svm();
    let Some(px) = load_pump(&mut svm) else { return };
    let (t, pk) = claim_ready(&mut svm, &px);
    let bob = t.bob.pubkey();
    assert_eq!(read_session(&svm, 0, &bob).tokens_held, 0);
    let launch_before = lamports(&svm, &launch_pda(0));
    send(
        &mut svm,
        &t.cranker,
        &[],
        &[pump_claim_ix(&t.cranker.pubkey(), &bob, 0, &pk, 0, 0)],
    )
    .unwrap();
    assert_eq!(lamports(&svm, &launch_pda(0)), launch_before, "no lamport moved");
    assert!(read_session(&svm, 0, &bob).tokens_claimed);
    assert_eq!(read_pump(&svm, 0).claims_done, 1, "bob traded, so he counts");
    assert_eq!(lamports(&svm, &ata_address(&bob, &pk.mint)), 0, "no ata created");
}

#[test]
fn pump_claim_two_sessions_complete_the_count() {
    let mut svm = fresh_svm();
    let Some(px) = load_pump(&mut svm) else { return };
    let (t, pk) = claim_ready(&mut svm, &px);
    let alice = t.alice.pubkey();
    let amount = ceiling_of(read_session(&svm, 0, &alice).tokens_held) / 2;
    send(
        &mut svm,
        &t.cranker,
        &[],
        &[pump_claim_ix(&t.cranker.pubkey(), &alice, 0, &pk, amount, 700_000_000)],
    )
    .unwrap();
    send(
        &mut svm,
        &t.cranker,
        &[],
        &[pump_claim_ix(&t.cranker.pubkey(), &t.bob.pubkey(), 0, &pk, 0, 0)],
    )
    .unwrap();
    assert_eq!(read_pump(&svm, 0).claims_done, read_launch(&svm, 0).sessions_opened);
}

#[test]
fn pump_claim_rejections() {
    let mut svm = fresh_svm();
    let Some(px) = load_pump(&mut svm) else { return };
    let (t, pk) = claim_ready(&mut svm, &px);
    let alice = t.alice.pubkey();
    let cr = t.cranker.pubkey();
    let held = read_session(&svm, 0, &alice).tokens_held;
    let ceiling = ceiling_of(held);

    // more SOL than the pot holds
    let res = send(&mut svm, &t.cranker, &[], &[pump_claim_ix(&cr, &alice, 0, &pk, ceiling / 2, 2 * LAMPORTS_PER_SOL)]);
    assert_pad_error(res, E_POT_TOO_SMALL, "max_sol_cost above the pot");
    // over the haircut ceiling
    let res = send(&mut svm, &t.cranker, &[], &[pump_claim_ix(&cr, &alice, 0, &pk, ceiling + 1, 700_000_000)]);
    assert_pad_error(res, E_CLAIM_TOO_LARGE, "ceiling + 1");
    // a holder with tokens must claim something
    let res = send(&mut svm, &t.cranker, &[], &[pump_claim_ix(&cr, &alice, 0, &pk, 0, 0)]);
    assert_pad_error(res, E_BAD_QUOTE, "amount 0 with tokens held");
    // the ata must be the trader's
    let mut ix = pump_claim_ix(&cr, &alice, 0, &pk, ceiling / 2, 700_000_000);
    ix.accounts[7].pubkey = ata_address(&cr, &pk.mint);
    let res = send(&mut svm, &t.cranker, &[], &[ix]);
    assert_pad_error(res, E_BAD_PUMP_ACCOUNT, "cranker's ata instead of alice's");
    // bob (no tokens) may not claim a positive amount
    let res = send(&mut svm, &t.cranker, &[], &[pump_claim_ix(&cr, &t.bob.pubkey(), 0, &pk, 1, 1_000_000)]);
    assert_pad_error(res, E_CLAIM_TOO_LARGE, "flat session with amount > 0");
    // wrong pump mint account
    let mut ix = pump_claim_ix(&cr, &alice, 0, &pk, ceiling / 2, 700_000_000);
    ix.accounts[6].pubkey = solana_keypair::Keypair::new().pubkey();
    let res = send(&mut svm, &t.cranker, &[], &[ix]);
    assert_pad_error(res, E_WRONG_PUMP_MINT, "mint != pump.pump_mint");
    // happy path, then a second claim is refused
    send(&mut svm, &t.cranker, &[], &[pump_claim_ix(&cr, &alice, 0, &pk, ceiling / 2, 700_000_000)]).unwrap();
    svm.expire_blockhash();
    let res = send(&mut svm, &t.cranker, &[], &[pump_claim_ix(&cr, &alice, 0, &pk, ceiling / 2, 700_000_000)]);
    assert_pad_error(res, E_ALREADY_CLAIMED, "second claim");
}

#[test]
fn pump_claim_needs_the_mint_and_a_reconciled_session() {
    let mut svm = fresh_svm();
    let Some(px) = load_pump(&mut svm) else { return };
    let t = frozen_pump_launch(&mut svm, &px);
    let pk = PumpKeys::from(&px);
    let alice = t.alice.pubkey();
    // frozen, not reconciled, mint not set → the mint check fires first (constraint)
    let res = send(&mut svm, &t.cranker, &[], &[pump_claim_ix(&t.cranker.pubkey(), &alice, 0, &pk, 1, 1_000_000)]);
    assert_pad_error(res, E_PUMP_MINT_NOT_SET, "before set_pump_mint");
    send(&mut svm, &t.admin, &[], &[set_pump_mint_ix(&t.admin.pubkey(), 0, &px.mint, &px.bonding_curve)]).unwrap();
    let res = send(&mut svm, &t.cranker, &[], &[pump_claim_ix(&t.cranker.pubkey(), &alice, 0, &pk, 1, 1_000_000)]);
    assert_pad_error(res, E_NOT_RECONCILED, "session not reconciled");
}
