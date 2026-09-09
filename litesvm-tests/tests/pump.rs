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
    let admin_before = lamports(&svm, &t.admin.pubkey());

    send(
        &mut svm,
        &t.admin,
        &[],
        &[pump_claim_ix(&t.admin.pubkey(), &alice, 0, &pk, amount, 700_000_000)],
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
    // the cranking admin only paid the tx fee
    assert!(admin_before - lamports(&svm, &t.admin.pubkey()) < 20_000);
}

#[test]
fn pump_claim_into_an_existing_ata() {
    // the create_idempotent no-op branch: the ATA is already open when the
    // claim lands, so the vault pays no rent for it and the 165-byte slice of
    // the allowance is swept straight back to the launch. Same conservation
    // identity as the fresh-ATA test MINUS the ata term — bob paid that.
    let mut svm = fresh_svm();
    let Some(px) = load_pump(&mut svm) else { return };
    let (t, pk) = claim_ready(&mut svm, &px);
    let alice = t.alice.pubkey();
    let amount = ceiling_of(read_session(&svm, 0, &alice).tokens_held) / 2;
    let ata = ata_address(&alice, &pk.mint);
    let cv = creator_vault_pda(&pk.creator);

    // a stranger opens alice's ATA out of his own pocket, before the claim
    send(
        &mut svm,
        &t.bob,
        &[],
        &[create_ata_idempotent_ix(&t.bob.pubkey(), &alice, &pk.mint)],
    )
    .unwrap();
    let ata_rent = lamports(&svm, &ata);
    assert!(ata_rent > 0, "the ata is open before the claim");
    assert_eq!(token_amount(&svm, &ata), 0);

    let launch_before = lamports(&svm, &launch_pda(0));
    let bc_before = lamports(&svm, &px.bonding_curve);
    let fee_before = lamports(&svm, &pk.fee_recipient);
    let bb_before = lamports(&svm, &pk.buyback);
    let cv_before = lamports(&svm, &cv);

    send(
        &mut svm,
        &t.admin,
        &[],
        &[pump_claim_ix(&t.admin.pubkey(), &alice, 0, &pk, amount, 700_000_000)],
    )
    .unwrap();

    assert_eq!(token_amount(&svm, &ata), amount, "exact amount into the open ata");
    assert_eq!(lamports(&svm, &ata), ata_rent, "its rent is untouched — bob paid it, not the launch");
    assert_eq!(lamports(&svm, &pump_vault_pda(0, &alice)), 0, "vault swept back");
    let spent = launch_before - lamports(&svm, &launch_pda(0));
    let landed = (lamports(&svm, &px.bonding_curve) - bc_before)
        + (lamports(&svm, &pk.fee_recipient) - fee_before)
        + (lamports(&svm, &pk.buyback) - bb_before)
        + (lamports(&svm, &cv) - cv_before);
    assert_eq!(spent, landed, "lamport conservation, no ata rent on the launch's tab");
    assert!(read_session(&svm, 0, &alice).tokens_claimed);
    assert_eq!(read_pump(&svm, 0).claims_done, 1);
}

#[test]
fn pump_claim_rejects_a_stranger_crank() {
    // `amount` is caller-chosen, so a permissionless crank is a griefing
    // weapon: one token into the ATA marks tokens_claimed and the real share
    // is gone forever. Only the admin may fire it.
    let mut svm = fresh_svm();
    let Some(px) = load_pump(&mut svm) else { return };
    let (t, pk) = claim_ready(&mut svm, &px);
    let alice = t.alice.pubkey();
    let amount = ceiling_of(read_session(&svm, 0, &alice).tokens_held) / 2;
    let res = send(
        &mut svm,
        &t.cranker,
        &[],
        &[pump_claim_ix(&t.cranker.pubkey(), &alice, 0, &pk, amount, 700_000_000)],
    );
    assert_pad_error(res, E_UNAUTHORIZED, "the cranker is not the admin");
    assert!(!read_session(&svm, 0, &alice).tokens_claimed, "her claim is untouched");
    assert_eq!(read_pump(&svm, 0).claims_done, 0);
}

#[test]
fn pump_claim_rejects_the_trader_themself() {
    // there is no self-service claim. The caller picks `amount` AND
    // `max_sol_cost`, and the pot guard bounds `max_sol_cost` only by the
    // whole pot — a holder cranking herself could overpay the curve out of
    // everyone's pot. Only the budgeting keeper (the admin) may crank.
    let mut svm = fresh_svm();
    let Some(px) = load_pump(&mut svm) else { return };
    let (t, pk) = claim_ready(&mut svm, &px);
    let alice = t.alice.pubkey();
    let amount = ceiling_of(read_session(&svm, 0, &alice).tokens_held) / 2;
    let res = send(
        &mut svm,
        &t.alice,
        &[],
        &[pump_claim_ix(&alice, &alice, 0, &pk, amount, 700_000_000)],
    );
    assert_pad_error(res, E_UNAUTHORIZED, "alice may not crank her own claim");
    assert!(!read_session(&svm, 0, &alice).tokens_claimed, "her claim is untouched");
    assert_eq!(read_pump(&svm, 0).claims_done, 0);
    assert_eq!(lamports(&svm, &ata_address(&alice, &pk.mint)), 0, "no ata created");
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
        &t.admin,
        &[],
        &[pump_claim_ix(&t.admin.pubkey(), &bob, 0, &pk, 0, 0)],
    )
    .unwrap();
    assert_eq!(lamports(&svm, &launch_pda(0)), launch_before, "no lamport moved");
    assert!(read_session(&svm, 0, &bob).tokens_claimed);
    assert_eq!(read_pump(&svm, 0).claims_done, 1, "bob traded, so he counts");
    assert_eq!(lamports(&svm, &ata_address(&bob, &pk.mint)), 0, "no ata created");
}

#[test]
fn pump_claim_on_a_launch_nobody_traded() {
    // the other half of Launch::is_settled(): FROZEN with
    // sessions_reconciled == sessions_opened, which only happens when nobody
    // ever bought. The admin freezes a fizzled market, the deposit-only
    // session reconciles without moving either counter, and the claim still
    // closes the books.
    let mut svm = fresh_svm();
    let Some(px) = load_pump(&mut svm) else { return };
    let t = setup_pump_table(&mut svm, &px);
    send(&mut svm, &t.creator, &[], &[enable_pump_ix(&t.creator.pubkey(), 0)]).unwrap();
    let alice = t.alice.pubkey();
    send(
        &mut svm,
        &t.alice,
        &[],
        &[open_trade_session_ix(&alice, 0, &t.ka.pubkey(), LAMPORTS_PER_SOL)],
    )
    .unwrap();
    // no buy ever priced the curve, so the janitor freeze is the only way out
    send(&mut svm, &t.admin, &[], &[freeze_launch_ix(&t.admin.pubkey(), 0)]).unwrap();
    send(
        &mut svm,
        &t.admin,
        &[],
        &[set_pump_mint_ix(&t.admin.pubkey(), 0, &px.mint, &px.bonding_curve)],
    )
    .unwrap();
    send(&mut svm, &t.cranker, &[], &[reconcile_ix(&alice, 0)]).unwrap();
    let l = read_launch(&svm, 0);
    assert_eq!(l.state, FROZEN, "a never-traded session leaves the state alone");
    assert_eq!(l.sessions_opened, 0);
    assert_eq!(l.sessions_reconciled, 0, "0 == 0 is what makes the launch settled");

    let pk = PumpKeys::from(&px);
    let launch_before = lamports(&svm, &launch_pda(0));
    send(
        &mut svm,
        &t.admin,
        &[],
        &[pump_claim_ix(&t.admin.pubkey(), &alice, 0, &pk, 0, 0)],
    )
    .unwrap();
    assert!(read_session(&svm, 0, &alice).tokens_claimed, "the books close");
    assert_eq!(read_pump(&svm, 0).claims_done, 0, "she never traded, so she never counts");
    assert_eq!(read_launch(&svm, 0).state, FROZEN, "the claim moves no state");
    assert_eq!(lamports(&svm, &launch_pda(0)), launch_before, "no lamport moved");
    assert_eq!(lamports(&svm, &ata_address(&alice, &pk.mint)), 0, "no ata created");
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
        &t.admin,
        &[],
        &[pump_claim_ix(&t.admin.pubkey(), &alice, 0, &pk, amount, 700_000_000)],
    )
    .unwrap();
    send(
        &mut svm,
        &t.admin,
        &[],
        &[pump_claim_ix(&t.admin.pubkey(), &t.bob.pubkey(), 0, &pk, 0, 0)],
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
    let ad = t.admin.pubkey();
    let held = read_session(&svm, 0, &alice).tokens_held;
    let ceiling = ceiling_of(held);

    // more SOL than the pot holds
    let res = send(&mut svm, &t.admin, &[], &[pump_claim_ix(&ad, &alice, 0, &pk, ceiling / 2, 2 * LAMPORTS_PER_SOL)]);
    assert_pad_error(res, E_POT_TOO_SMALL, "max_sol_cost above the pot");
    // over the haircut ceiling
    let res = send(&mut svm, &t.admin, &[], &[pump_claim_ix(&ad, &alice, 0, &pk, ceiling + 1, 700_000_000)]);
    assert_pad_error(res, E_CLAIM_TOO_LARGE, "ceiling + 1");
    // a holder with tokens must claim something
    let res = send(&mut svm, &t.admin, &[], &[pump_claim_ix(&ad, &alice, 0, &pk, 0, 0)]);
    assert_pad_error(res, E_BAD_QUOTE, "amount 0 with tokens held");
    // the ata must be the trader's
    // 0 cranker 1 platform 2 trader 3 launch 4 pump 5 session 6 vault 7 pump_mint 8 trader_ata
    let mut ix = pump_claim_ix(&ad, &alice, 0, &pk, ceiling / 2, 700_000_000);
    ix.accounts[8].pubkey = ata_address(&ad, &pk.mint);
    let res = send(&mut svm, &t.admin, &[], &[ix]);
    assert_pad_error(res, E_BAD_PUMP_ACCOUNT, "the admin's ata instead of alice's");
    // bob (no tokens) may not claim a positive amount
    let res = send(&mut svm, &t.admin, &[], &[pump_claim_ix(&ad, &t.bob.pubkey(), 0, &pk, 1, 1_000_000)]);
    assert_pad_error(res, E_CLAIM_TOO_LARGE, "flat session with amount > 0");
    // wrong pump mint account
    let mut ix = pump_claim_ix(&ad, &alice, 0, &pk, ceiling / 2, 700_000_000);
    ix.accounts[7].pubkey = solana_keypair::Keypair::new().pubkey();
    let res = send(&mut svm, &t.admin, &[], &[ix]);
    assert_pad_error(res, E_WRONG_PUMP_MINT, "mint != pump.pump_mint");
    // happy path, then a second claim is refused
    send(&mut svm, &t.admin, &[], &[pump_claim_ix(&ad, &alice, 0, &pk, ceiling / 2, 700_000_000)]).unwrap();
    // the pot never dips below the launch PDA's own rent floor
    let l = svm.get_account(&launch_pda(0)).expect("launch");
    assert!(
        l.lamports >= svm.minimum_balance_for_rent_exemption(l.data.len()),
        "launch still rent-exempt after the claim: {} lamports for {} bytes",
        l.lamports,
        l.data.len()
    );
    svm.expire_blockhash();
    let res = send(&mut svm, &t.admin, &[], &[pump_claim_ix(&ad, &alice, 0, &pk, ceiling / 2, 700_000_000)]);
    assert_pad_error(res, E_ALREADY_CLAIMED, "second claim");
}

#[test]
fn pump_claim_needs_the_mint_and_a_reconciled_session() {
    let mut svm = fresh_svm();
    let Some(px) = load_pump(&mut svm) else { return };
    // built by hand rather than via frozen_pump_launch: bob's deposit-only
    // session has to be opened while the launch is still BONDING
    // (open_trade_session requires it), and he must never trade, so he is not
    // counted in sessions_opened and the launch can reconcile without him.
    let t = setup_pump_table(&mut svm, &px);
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
        &t.bob,
        &[],
        &[open_trade_session_ix(&t.bob.pubkey(), 0, &t.kb.pubkey(), 500_000_000)],
    )
    .unwrap();
    send(&mut svm, &t.cranker, &[&t.ka], &[buy_ix_pump(&t.ka.pubkey(), &t.alice.pubkey(), 0, 1_100_000_000)]).unwrap();
    assert_eq!(read_launch(&svm, 0).state, FROZEN);
    assert_eq!(read_launch(&svm, 0).sessions_opened, 1, "bob never bought");
    let pk = PumpKeys::from(&px);
    let alice = t.alice.pubkey();
    let bob = t.bob.pubkey();
    // frozen, not reconciled, mint not set → the mint check fires first (constraint)
    let res = send(&mut svm, &t.admin, &[], &[pump_claim_ix(&t.admin.pubkey(), &alice, 0, &pk, 1, 1_000_000)]);
    assert_pad_error(res, E_PUMP_MINT_NOT_SET, "before set_pump_mint");
    send(&mut svm, &t.admin, &[], &[set_pump_mint_ix(&t.admin.pubkey(), 0, &px.mint, &px.bonding_curve)]).unwrap();
    // the pin may land on a FROZEN launch; the claim may not
    let res = send(&mut svm, &t.admin, &[], &[pump_claim_ix(&t.admin.pubkey(), &alice, 0, &pk, 1, 1_000_000)]);
    assert_pad_error(res, E_LAUNCH_NOT_RECONCILED, "launch still frozen");
    // alice is the only counted session, so her reconcile finishes the launch
    send(&mut svm, &t.cranker, &[], &[reconcile_ix(&alice, 0)]).unwrap();
    assert_eq!(read_launch(&svm, 0).state, RECONCILED);
    // …and bob's untraded session is still unsettled: the session-level gate
    // is reachable on a RECONCILED launch, which is why it stays
    assert!(!read_session(&svm, 0, &bob).reconciled);
    let res = send(&mut svm, &t.admin, &[], &[pump_claim_ix(&t.admin.pubkey(), &bob, 0, &pk, 0, 0)]);
    assert_pad_error(res, E_NOT_RECONCILED, "session not reconciled");
    send(&mut svm, &t.cranker, &[], &[reconcile_ix(&bob, 0)]).unwrap();
    assert_eq!(read_launch(&svm, 0).state, RECONCILED, "an untraded session does not move the count");
    send(&mut svm, &t.admin, &[], &[pump_claim_ix(&t.admin.pubkey(), &bob, 0, &pk, 0, 0)]).unwrap();
    assert!(read_session(&svm, 0, &bob).tokens_claimed);
    assert_eq!(read_pump(&svm, 0).claims_done, 0, "bob never traded, so he never counts");
}

#[test]
fn pump_claim_waits_for_the_launch_to_reconcile() {
    // bob's own session is settled, alice's is not — so the launch is still
    // FROZEN and her profit is still owed out of this same pot, which
    // pot_available reserves nothing for. Claims wait for the whole launch.
    let mut svm = fresh_svm();
    let Some(px) = load_pump(&mut svm) else { return };
    let t = setup_pump_table(&mut svm, &px);
    send(&mut svm, &t.creator, &[], &[enable_pump_ix(&t.creator.pubkey(), 0)]).unwrap();
    send(
        &mut svm,
        &t.alice,
        &[],
        &[open_trade_session_ix(&t.alice.pubkey(), 0, &t.ka.pubkey(), 1_200_000_000)],
    )
    .unwrap();
    send(
        &mut svm,
        &t.bob,
        &[],
        &[open_trade_session_ix(&t.bob.pubkey(), 0, &t.kb.pubkey(), 500_000_000)],
    )
    .unwrap();
    send(&mut svm, &t.cranker, &[&t.kb], &[buy_ix_pump(&t.kb.pubkey(), &t.bob.pubkey(), 0, 100_000_000)]).unwrap();
    let held = read_session(&svm, 0, &t.bob.pubkey()).tokens_held;
    send(&mut svm, &t.cranker, &[&t.kb], &[sell_ix(&t.kb.pubkey(), &t.bob.pubkey(), 0, held)]).unwrap();
    send(&mut svm, &t.cranker, &[&t.ka], &[buy_ix_pump(&t.ka.pubkey(), &t.alice.pubkey(), 0, 1_100_000_000)]).unwrap();
    assert_eq!(read_launch(&svm, 0).state, FROZEN);
    assert_eq!(read_launch(&svm, 0).sessions_opened, 2);
    // only the flat loser settles
    send(&mut svm, &t.cranker, &[], &[reconcile_ix(&t.bob.pubkey(), 0)]).unwrap();
    assert_eq!(read_launch(&svm, 0).state, FROZEN, "alice is still outstanding");
    send(&mut svm, &t.admin, &[], &[set_pump_mint_ix(&t.admin.pubkey(), 0, &px.mint, &px.bonding_curve)]).unwrap();
    let pk = PumpKeys::from(&px);
    let bob = t.bob.pubkey();
    assert!(read_session(&svm, 0, &bob).reconciled, "bob's own session is settled");
    let res = send(&mut svm, &t.admin, &[], &[pump_claim_ix(&t.admin.pubkey(), &bob, 0, &pk, 0, 0)]);
    assert_pad_error(res, E_LAUNCH_NOT_RECONCILED, "a settled session on an unsettled launch");
    assert!(!read_session(&svm, 0, &bob).tokens_claimed, "nothing was booked");
}

// ---- pump_graduate --------------------------------------------------------

/// claim_ready + both claims done
fn all_claimed(svm: &mut litesvm::LiteSVM, px: &PumpFixtures) -> (Table, PumpKeys) {
    let (t, pk) = claim_ready(svm, px);
    let alice = t.alice.pubkey();
    let amount = ceiling_of(read_session(svm, 0, &alice).tokens_held) / 2;
    send(svm, &t.admin, &[], &[pump_claim_ix(&t.admin.pubkey(), &alice, 0, &pk, amount, 700_000_000)]).unwrap();
    send(svm, &t.admin, &[], &[pump_claim_ix(&t.admin.pubkey(), &t.bob.pubkey(), 0, &pk, 0, 0)]).unwrap();
    assert_eq!(read_pump(svm, 0).claims_done, 2);
    (t, pk)
}

#[test]
fn pump_graduate_burns_the_remainder_and_revokes_the_mint() {
    let mut svm = fresh_svm();
    let Some(px) = load_pump(&mut svm) else { return };
    let (t, pk) = all_claimed(&mut svm, &px);
    let vault = pump_launch_vault_pda(0);
    let vault_ata = ata_address(&vault, &pk.mint);
    let cv = creator_vault_pda(&pk.creator);
    let supply_before = mint_supply(&svm, &pk.mint);
    let launch_before = lamports(&svm, &launch_pda(0));
    let platform_before = lamports(&svm, &platform_pda());
    let bc_before = lamports(&svm, &px.bonding_curve);
    let fee_before = lamports(&svm, &pk.fee_recipient);
    let bb_before = lamports(&svm, &pk.buyback);
    let cv_before = lamports(&svm, &cv);
    let amount = 5_000_000_000_000u64; // 5M tokens
    send(
        &mut svm,
        &t.admin,
        &[],
        &[pump_graduate_ix(&t.admin.pubkey(), 0, &pk, amount, 300_000_000)],
    )
    .unwrap();
    let l = read_launch(&svm, 0);
    assert_eq!(l.state, GRADUATED);
    let rent_min = svm.minimum_balance_for_rent_exemption(svm.get_account(&launch_pda(0)).unwrap().data.len());
    assert_eq!(lamports(&svm, &launch_pda(0)), rent_min, "launch keeps only its rent");
    // every lamport that left the launch landed somewhere nameable: the
    // platform's residue plus the four pump-side accounts the buy pays. The
    // ATA rent nets out (the vault fronts it, close_account gives it back).
    assert_eq!(
        launch_before - lamports(&svm, &launch_pda(0)),
        (lamports(&svm, &platform_pda()) - platform_before)
            + (lamports(&svm, &px.bonding_curve) - bc_before)
            + (lamports(&svm, &pk.fee_recipient) - fee_before)
            + (lamports(&svm, &pk.buyback) - bb_before)
            + (lamports(&svm, &cv) - cv_before),
        "every lamport that left the launch is accounted for"
    );
    assert_eq!(mint_supply(&svm, &pk.mint), supply_before - amount, "bought tokens were burnt");
    assert_eq!(lamports(&svm, &vault_ata), 0, "vault ata closed");
    assert_eq!(lamports(&svm, &vault), 0, "vault swept");
    assert_eq!(mint_authority_opt(&svm, &mint_pda(0)), None, "Mooner mint revoked");
}

#[test]
fn pump_graduate_with_zero_amount_only_settles() {
    let mut svm = fresh_svm();
    let Some(px) = load_pump(&mut svm) else { return };
    let (t, pk) = all_claimed(&mut svm, &px);
    let supply_before = mint_supply(&svm, &pk.mint);
    let platform_before = lamports(&svm, &platform_pda());
    let launch_before = lamports(&svm, &launch_pda(0));
    send(&mut svm, &t.admin, &[], &[pump_graduate_ix(&t.admin.pubkey(), 0, &pk, 0, 0)]).unwrap();
    assert_eq!(read_launch(&svm, 0).state, GRADUATED);
    assert_eq!(mint_supply(&svm, &pk.mint), supply_before, "no buy, no burn");
    let rent_min = svm.minimum_balance_for_rent_exemption(svm.get_account(&launch_pda(0)).unwrap().data.len());
    assert_eq!(lamports(&svm, &platform_pda()) - platform_before, launch_before - rent_min);
    assert_eq!(mint_authority_opt(&svm, &mint_pda(0)), None);
}

#[test]
fn pump_graduate_spends_the_flip_pot_of_a_fairest_launch() {
    // launch 1 is fairest: bob's instant flip is taxed into flip_pot. A claim
    // must not reach into the pot; graduation spends it.
    let mut svm = fresh_svm();
    let Some(px) = load_pump(&mut svm) else { return };
    let t = setup_pump_table(&mut svm, &px);
    send(&mut svm, &t.creator, &[], &[create_launch_fair_ix(&t.creator.pubkey(), 1, "FAIREST", "FAIR")]).unwrap();
    send(&mut svm, &t.creator, &[], &[enable_pump_ix(&t.creator.pubkey(), 1)]).unwrap();
    send(&mut svm, &t.alice, &[], &[open_trade_session_ix(&t.alice.pubkey(), 1, &t.ka.pubkey(), 1_500_000_000)]).unwrap();
    send(&mut svm, &t.bob, &[], &[open_trade_session_ix(&t.bob.pubkey(), 1, &t.kb.pubkey(), 500_000_000)]).unwrap();
    send(&mut svm, &t.cranker, &[&t.kb], &[buy_ix_pump(&t.kb.pubkey(), &t.bob.pubkey(), 1, 200_000_000)]).unwrap();
    let held = read_session(&svm, 1, &t.bob.pubkey()).tokens_held;
    // same clock as the buy → age zero → the full 25% rate (fair.rs precedent)
    send(&mut svm, &t.cranker, &[&t.kb], &[sell_ix(&t.kb.pubkey(), &t.bob.pubkey(), 1, held)]).unwrap();
    let tax = read_launch(&svm, 1).flip_pot;
    assert!(tax > 0, "the flip was taxed into the pot");
    send(&mut svm, &t.cranker, &[&t.ka], &[buy_ix_pump(&t.ka.pubkey(), &t.alice.pubkey(), 1, 1_100_000_000)]).unwrap();
    assert_eq!(read_launch(&svm, 1).state, FROZEN);
    send(&mut svm, &t.cranker, &[], &[reconcile_ix(&t.bob.pubkey(), 1)]).unwrap();
    send(&mut svm, &t.cranker, &[], &[reconcile_ix(&t.alice.pubkey(), 1)]).unwrap();
    assert_eq!(read_launch(&svm, 1).state, RECONCILED);
    assert_eq!(read_launch(&svm, 1).flip_pot, tax, "reconcile leaves the pot alone");
    send(&mut svm, &t.admin, &[], &[set_pump_mint_ix(&t.admin.pubkey(), 1, &px.mint, &px.bonding_curve)]).unwrap();
    let pk = PumpKeys::from(&px);

    let rent_min = svm.minimum_balance_for_rent_exemption(svm.get_account(&launch_pda(1)).unwrap().data.len());
    let allowance = svm.minimum_balance_for_rent_exemption(165)
        + svm.minimum_balance_for_rent_exemption(137)
        + svm.minimum_balance_for_rent_exemption(0);
    // what a claim may spend: everything above rent EXCEPT the pot
    let free = lamports(&svm, &launch_pda(1)) - rent_min - tax as u64;
    let alice = t.alice.pubkey();
    let amount = ceiling_of(read_session(&svm, 1, &alice).tokens_held) / 4;
    let res = send(&mut svm, &t.admin, &[], &[pump_claim_ix(&t.admin.pubkey(), &alice, 1, &pk, amount, free - allowance + 1)]);
    assert_pad_error(res, E_POT_TOO_SMALL, "a claim cannot reach into the flip pot");
    send(&mut svm, &t.admin, &[], &[pump_claim_ix(&t.admin.pubkey(), &alice, 1, &pk, amount, free / 2)]).unwrap();
    send(&mut svm, &t.admin, &[], &[pump_claim_ix(&t.admin.pubkey(), &t.bob.pubkey(), 1, &pk, 0, 0)]).unwrap();
    assert_eq!(read_launch(&svm, 1).flip_pot, tax, "claims leave the pot alone");

    // graduation may spend the pot: a cap that only fits WITH the pot passes
    let with_pot = lamports(&svm, &launch_pda(1)) - rent_min - allowance;
    assert!(with_pot > lamports(&svm, &launch_pda(1)) - rent_min - allowance - tax as u64);
    let supply_before = mint_supply(&svm, &pk.mint);
    let g_amount = 1_000_000_000_000u64; // 1M tokens: well under what `with_pot` buys on a fresh curve
    send(&mut svm, &t.admin, &[], &[pump_graduate_ix(&t.admin.pubkey(), 1, &pk, g_amount, with_pot)]).unwrap();
    assert_eq!(read_launch(&svm, 1).state, GRADUATED);
    assert_eq!(lamports(&svm, &launch_pda(1)), rent_min, "pot and dust both left the launch");
    assert_eq!(mint_supply(&svm, &pk.mint), supply_before - g_amount, "bought tokens were burnt");
    let g_vault = pump_launch_vault_pda(1);
    assert_eq!(lamports(&svm, &g_vault), 0, "vault swept");
    assert_eq!(lamports(&svm, &ata_address(&g_vault, &pk.mint)), 0, "vault ata closed");
}

#[test]
fn pump_graduate_rejections() {
    let mut svm = fresh_svm();
    let Some(px) = load_pump(&mut svm) else { return };
    let (t, pk) = claim_ready(&mut svm, &px);
    // claims outstanding
    let res = send(&mut svm, &t.admin, &[], &[pump_graduate_ix(&t.admin.pubkey(), 0, &pk, 0, 0)]);
    assert_pad_error(res, E_PUMP_CLAIMS_OUTSTANDING, "nobody claimed yet");
    let alice = t.alice.pubkey();
    let amount = ceiling_of(read_session(&svm, 0, &alice).tokens_held) / 2;
    send(&mut svm, &t.admin, &[], &[pump_claim_ix(&t.admin.pubkey(), &alice, 0, &pk, amount, 700_000_000)]).unwrap();
    send(&mut svm, &t.admin, &[], &[pump_claim_ix(&t.admin.pubkey(), &t.bob.pubkey(), 0, &pk, 0, 0)]).unwrap();
    // non-admin
    let res = send(&mut svm, &t.alice, &[], &[pump_graduate_ix(&t.alice.pubkey(), 0, &pk, 0, 0)]);
    assert_pad_error(res, E_UNAUTHORIZED, "alice is not admin");
    // pot too small for the burn buy
    let res = send(&mut svm, &t.admin, &[], &[pump_graduate_ix(&t.admin.pubkey(), 0, &pk, 1_000_000_000_000, 5 * LAMPORTS_PER_SOL)]);
    assert_pad_error(res, E_POT_TOO_SMALL, "5 SOL max on a ~0.3 SOL remainder");
    // a cap with nothing to buy: the argument is bound, not ignored, so a CLI
    // argument-order slip is an error rather than a silent no-op
    let res = send(&mut svm, &t.admin, &[], &[pump_graduate_ix(&t.admin.pubkey(), 0, &pk, 0, 1)]);
    assert_pad_error(res, E_BAD_QUOTE, "a cap with nothing to buy");
    send(&mut svm, &t.admin, &[], &[pump_graduate_ix(&t.admin.pubkey(), 0, &pk, 0, 0)]).unwrap();
    svm.expire_blockhash();
    let res = send(&mut svm, &t.admin, &[], &[pump_graduate_ix(&t.admin.pubkey(), 0, &pk, 0, 0)]);
    assert_pad_error(res, E_NOT_GRADUATABLE, "already graduated");
}

#[test]
fn pump_graduate_burns_dust_parked_in_the_vault_ata() {
    // The launch vault's ATA is ATA(["pumpvault", launch_id], pump_mint) —
    // both keys are public from set_pump_mint on, so anyone holding one raw
    // unit (every claimed holder does) can open that ATA and park dust in it.
    // Burning only `amount` would leave the dust behind and close_account
    // would fail ("Non-native account can only be closed if its balance is
    // zero"), jamming every amount > 0 graduation of this launch forever —
    // the admin's only exit would be amount = 0, which hands the whole
    // remainder to the platform instead of the curve. So the burn takes
    // whatever the ATA holds.
    let mut svm = fresh_svm();
    let Some(px) = load_pump(&mut svm) else { return };
    let (t, pk) = all_claimed(&mut svm, &px);
    let alice = t.alice.pubkey();
    let alice_ata = ata_address(&alice, &pk.mint);
    let vault = pump_launch_vault_pda(0);
    let vault_ata = ata_address(&vault, &pk.mint);
    assert!(token_amount(&svm, &alice_ata) > 1, "alice has tokens to donate");

    // alice opens the vault's ATA out of her own pocket and parks one raw unit
    send(
        &mut svm,
        &t.alice,
        &[],
        &[
            create_ata_idempotent_ix(&alice, &vault, &pk.mint),
            spl_transfer_ix(&alice_ata, &vault_ata, &alice, 1),
        ],
    )
    .unwrap();
    assert_eq!(token_amount(&svm, &vault_ata), 1, "dust is parked in the vault's ata");

    let supply_before = mint_supply(&svm, &pk.mint);
    let amount = 5_000_000_000_000u64; // 5M tokens
    send(
        &mut svm,
        &t.admin,
        &[],
        &[pump_graduate_ix(&t.admin.pubkey(), 0, &pk, amount, 300_000_000)],
    )
    .unwrap();
    assert_eq!(
        supply_before - mint_supply(&svm, &pk.mint),
        amount + 1,
        "the buy AND the parked dust were burnt"
    );
    assert_eq!(lamports(&svm, &vault_ata), 0, "the vault's ata is closed, dust and all");
    assert_eq!(lamports(&svm, &vault), 0, "vault swept");
    assert_eq!(read_launch(&svm, 0).state, GRADUATED);
    assert_eq!(mint_authority_opt(&svm, &mint_pda(0)), None, "Mooner mint revoked");
}

#[test]
fn pump_graduate_rejects_a_wrong_vault_ata() {
    // index 6 is vault_ata. The handler pins it by ATA derivation over BOTH
    // the vault's key and pump_mint, ahead of `need`, the pot bound and every
    // lamport move — so a substituted ATA costs the launch nothing.
    let mut svm = fresh_svm();
    let Some(px) = load_pump(&mut svm) else { return };
    let (t, pk) = all_claimed(&mut svm, &px);
    let launch_before = lamports(&svm, &launch_pda(0));
    // 0 admin 1 platform 2 launch 3 pump 4 mooner mint 5 vault 6 vault_ata 7 pump_mint
    let mut ix = pump_graduate_ix(&t.admin.pubkey(), 0, &pk, 5_000_000_000_000, 300_000_000);
    ix.accounts[6].pubkey = ata_address(&t.bob.pubkey(), &pk.mint);
    let res = send(&mut svm, &t.admin, &[], &[ix]);
    assert_pad_error(res, E_BAD_PUMP_ACCOUNT, "bob's ata instead of the vault's");
    assert_eq!(lamports(&svm, &launch_pda(0)), launch_before, "not a lamport moved");
    assert_eq!(read_launch(&svm, 0).state, RECONCILED, "still not graduated");
}

#[test]
fn pump_graduate_on_a_launch_nobody_traded() {
    // the FROZEN half of Launch::is_settled(): sessions_reconciled ==
    // sessions_opened == 0. Nothing was ever bought, so there is nothing to
    // buy back and nothing to burn — but the launch still has to reach its
    // terminal state, hand the residue over and seal the Mooner mint.
    // Mirrors pump_claim_on_a_launch_nobody_traded.
    let mut svm = fresh_svm();
    let Some(px) = load_pump(&mut svm) else { return };
    let t = setup_pump_table(&mut svm, &px);
    send(&mut svm, &t.creator, &[], &[enable_pump_ix(&t.creator.pubkey(), 0)]).unwrap();
    let alice = t.alice.pubkey();
    send(
        &mut svm,
        &t.alice,
        &[],
        &[open_trade_session_ix(&alice, 0, &t.ka.pubkey(), LAMPORTS_PER_SOL)],
    )
    .unwrap();
    // no buy ever priced the curve, so the janitor freeze is the only way out
    send(&mut svm, &t.admin, &[], &[freeze_launch_ix(&t.admin.pubkey(), 0)]).unwrap();
    send(
        &mut svm,
        &t.admin,
        &[],
        &[set_pump_mint_ix(&t.admin.pubkey(), 0, &px.mint, &px.bonding_curve)],
    )
    .unwrap();
    send(&mut svm, &t.cranker, &[], &[reconcile_ix(&alice, 0)]).unwrap();
    let l = read_launch(&svm, 0);
    assert_eq!(l.state, FROZEN, "a never-traded session leaves the state alone");
    assert_eq!(l.sessions_opened, 0);
    assert_eq!(l.sessions_reconciled, 0, "0 == 0 is what makes the launch settled");
    assert_eq!(read_pump(&svm, 0).claims_done, 0, "so the claims gate is 0 == 0 too");

    let pk = PumpKeys::from(&px);
    let launch_before = lamports(&svm, &launch_pda(0));
    let platform_before = lamports(&svm, &platform_pda());
    send(&mut svm, &t.admin, &[], &[pump_graduate_ix(&t.admin.pubkey(), 0, &pk, 0, 0)]).unwrap();
    assert_eq!(read_launch(&svm, 0).state, GRADUATED);
    let rent_min =
        svm.minimum_balance_for_rent_exemption(svm.get_account(&launch_pda(0)).unwrap().data.len());
    assert_eq!(lamports(&svm, &launch_pda(0)), rent_min, "launch keeps only its rent");
    assert_eq!(
        lamports(&svm, &platform_pda()) - platform_before,
        launch_before - rent_min,
        "the residue went to the platform"
    );
    assert_eq!(mint_authority_opt(&svm, &mint_pda(0)), None, "Mooner mint revoked");
}

#[test]
fn pump_claim_after_pump_graduate_is_closed() {
    // GRADUATED is neither RECONCILED nor FROZEN, so is_settled() is false
    // and pump_claim's LAUNCH-level gate fires ahead of the session-level
    // AlreadyClaimed. Nobody is stranded by it: pump_graduate could not have
    // run at all unless every session with sol_spent > 0 was already claimed.
    let mut svm = fresh_svm();
    let Some(px) = load_pump(&mut svm) else { return };
    let (t, pk) = all_claimed(&mut svm, &px);
    let alice = t.alice.pubkey();
    send(
        &mut svm,
        &t.admin,
        &[],
        &[pump_graduate_ix(&t.admin.pubkey(), 0, &pk, 5_000_000_000_000, 300_000_000)],
    )
    .unwrap();
    assert_eq!(read_launch(&svm, 0).state, GRADUATED);
    let held = token_amount(&svm, &ata_address(&alice, &pk.mint));
    let res = send(
        &mut svm,
        &t.admin,
        &[],
        &[pump_claim_ix(&t.admin.pubkey(), &alice, 0, &pk, 1, 1_000_000)],
    );
    assert_pad_error(res, E_LAUNCH_NOT_RECONCILED, "the launch is terminal, not settled");
    assert_eq!(
        token_amount(&svm, &ata_address(&alice, &pk.mint)),
        held,
        "her balance is untouched"
    );
}

#[test]
fn a_never_traded_session_reconciles_after_pump_graduate() {
    // A session that only deposited escrows its SOL in its OWN pda and is
    // never counted in sessions_opened, so the launch reconciles, claims and
    // graduates without it. reconcile_trade_session takes any state >= FROZEN
    // and GRADUATED is 3, so the deposit still walks home afterwards: net is
    // 0, the whole deposit goes to the trader and the pda keeps its rent.
    let mut svm = fresh_svm();
    let Some(px) = load_pump(&mut svm) else { return };
    let t = setup_pump_table(&mut svm, &px);
    // carol must open BEFORE the freezing buy — open_trade_session needs BONDING
    let carol = Keypair::new();
    let kc = Keypair::new();
    svm.airdrop(&carol.pubkey(), 5 * LAMPORTS_PER_SOL).unwrap();
    const CAROL_DEPOSIT: u64 = 300_000_000;
    send(&mut svm, &t.creator, &[], &[enable_pump_ix(&t.creator.pubkey(), 0)]).unwrap();
    send(
        &mut svm,
        &t.alice,
        &[],
        &[open_trade_session_ix(&t.alice.pubkey(), 0, &t.ka.pubkey(), 1_200_000_000)],
    )
    .unwrap();
    send(
        &mut svm,
        &t.bob,
        &[],
        &[open_trade_session_ix(&t.bob.pubkey(), 0, &t.kb.pubkey(), 500_000_000)],
    )
    .unwrap();
    send(
        &mut svm,
        &carol,
        &[],
        &[open_trade_session_ix(&carol.pubkey(), 0, &kc.pubkey(), CAROL_DEPOSIT)],
    )
    .unwrap();
    // bob in and straight out; alice's buy crosses the 1 SOL line
    send(&mut svm, &t.cranker, &[&t.kb], &[buy_ix_pump(&t.kb.pubkey(), &t.bob.pubkey(), 0, 100_000_000)]).unwrap();
    let held = read_session(&svm, 0, &t.bob.pubkey()).tokens_held;
    send(&mut svm, &t.cranker, &[&t.kb], &[sell_ix(&t.kb.pubkey(), &t.bob.pubkey(), 0, held)]).unwrap();
    send(&mut svm, &t.cranker, &[&t.ka], &[buy_ix_pump(&t.ka.pubkey(), &t.alice.pubkey(), 0, 1_100_000_000)]).unwrap();
    assert_eq!(read_launch(&svm, 0).state, FROZEN);
    assert_eq!(read_launch(&svm, 0).sessions_opened, 2, "carol never bought");
    send(&mut svm, &t.cranker, &[], &[reconcile_ix(&t.bob.pubkey(), 0)]).unwrap();
    send(&mut svm, &t.cranker, &[], &[reconcile_ix(&t.alice.pubkey(), 0)]).unwrap();
    assert_eq!(read_launch(&svm, 0).state, RECONCILED);
    send(
        &mut svm,
        &t.admin,
        &[],
        &[set_pump_mint_ix(&t.admin.pubkey(), 0, &px.mint, &px.bonding_curve)],
    )
    .unwrap();
    let pk = PumpKeys::from(&px);
    let amount = ceiling_of(read_session(&svm, 0, &t.alice.pubkey()).tokens_held) / 2;
    send(&mut svm, &t.admin, &[], &[pump_claim_ix(&t.admin.pubkey(), &t.alice.pubkey(), 0, &pk, amount, 700_000_000)]).unwrap();
    send(&mut svm, &t.admin, &[], &[pump_claim_ix(&t.admin.pubkey(), &t.bob.pubkey(), 0, &pk, 0, 0)]).unwrap();
    send(
        &mut svm,
        &t.admin,
        &[],
        &[pump_graduate_ix(&t.admin.pubkey(), 0, &pk, 5_000_000_000_000, 300_000_000)],
    )
    .unwrap();
    assert_eq!(read_launch(&svm, 0).state, GRADUATED);

    let session = session_pda(0, &carol.pubkey());
    let s_rent =
        svm.minimum_balance_for_rent_exemption(svm.get_account(&session).unwrap().data.len());
    assert_eq!(lamports(&svm, &session), s_rent + CAROL_DEPOSIT, "rent + escrow, untouched");
    let carol_before = lamports(&svm, &carol.pubkey());
    send(&mut svm, &t.cranker, &[], &[reconcile_ix(&carol.pubkey(), 0)]).unwrap();
    assert_eq!(
        lamports(&svm, &carol.pubkey()) - carol_before,
        CAROL_DEPOSIT,
        "the whole deposit walks home — net is 0, and the crank pays the fee"
    );
    assert_eq!(lamports(&svm, &session), s_rent, "rent stays with the pda; it is not closed");
    assert!(read_session(&svm, 0, &carol.pubkey()).reconciled);
    assert_eq!(read_launch(&svm, 0).sessions_reconciled, 2, "she never traded, so she never counts");
    assert_eq!(read_launch(&svm, 0).state, GRADUATED, "and the terminal state is untouched");
}
