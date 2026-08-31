//! Fairest mode end-to-end: the decaying flip tax lives in the ER ledger,
//! accrues on the launch, and ships with the raise at graduation. The curve
//! math itself never changes — the tax is carved from the seller's credit
//! AFTER the quote, so every determinism receipt stays valid.

mod common;
use common::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

const T0: i64 = 1_756_000_000; // deterministic clock anchor

/// fair launch id 1 next to the standard launch 0 from setup_table
fn fair_table(svm: &mut litesvm::LiteSVM) -> Table {
    let t = setup_table(svm);
    warp_to(svm, T0);
    send(svm, &t.creator, &[], &[create_launch_fair_ix(&t.creator.pubkey(), 1, "FAIREST", "FAIR")])
        .unwrap();
    t
}

fn open(svm: &mut litesvm::LiteSVM, who: &Keypair, key: &Keypair, launch_id: u64, deposit: u64) {
    send(svm, who, &[], &[open_trade_session_ix(&who.pubkey(), launch_id, &key.pubkey(), deposit)])
        .unwrap();
}

fn buy(svm: &mut litesvm::LiteSVM, t: &Table, who: &Keypair, key: &Keypair, launch_id: u64, amount: u64) {
    send(svm, &t.cranker, &[key], &[buy_ix(&key.pubkey(), &who.pubkey(), launch_id, amount)])
        .unwrap();
}

fn sell(svm: &mut litesvm::LiteSVM, t: &Table, who: &Keypair, key: &Keypair, launch_id: u64, tokens: u64) {
    send(svm, &t.cranker, &[key], &[sell_ix(&key.pubkey(), &who.pubkey(), launch_id, tokens)])
        .unwrap();
}

#[test]
fn fair_flag_arms_the_pot_standard_does_not() {
    let mut svm = fresh_svm();
    let _t = fair_table(&mut svm);
    assert_eq!(read_launch(&svm, 0).flip_pot, -1, "standard launch: no pot");
    assert_eq!(read_launch(&svm, 1).flip_pot, 0, "fair launch: pot armed at zero");
}

#[test]
fn instant_flip_pays_the_full_rate_into_the_pot() {
    let mut svm = fresh_svm();
    let t = fair_table(&mut svm);
    open(&mut svm, &t.alice, &t.ka, 1, 3 * LAMPORTS_PER_SOL);

    let spend = 2 * LAMPORTS_PER_SOL;
    buy(&mut svm, &t, &t.alice, &t.ka, 1, spend);
    let s = read_session(&svm, 1, &t.alice.pubkey());
    assert_eq!(s.entry_ts, T0 as u64, "first buy stamps entry = now");

    // instant dump of the whole bag — same clock, age zero
    let held = s.tokens_held;
    let l = read_launch(&svm, 1);
    let out = sell_quote(l.virtual_sol, l.virtual_tok, held);
    let tax = (out as u128 * FLIP_TAX_START_BPS as u128 / 10_000) as u64;
    assert!(tax > 0, "test must exercise a real tax");
    sell(&mut svm, &t, &t.alice, &t.ka, 1, held);

    let s = read_session(&svm, 1, &t.alice.pubkey());
    let l = read_launch(&svm, 1);
    assert_eq!(s.sol_proceeds, out - tax, "seller credited net of the flip tax");
    assert_eq!(l.flip_pot, tax as i64, "tax accrues on the launch");
    // the curve itself never saw the tax: reserves and the raise gauge move
    // by the GROSS quote, exactly as on a standard launch
    assert_eq!(l.virtual_sol, VIRTUAL_SOL_INIT + spend - out, "curve math untouched");
    assert_eq!(l.real_sol_raised, spend - out, "raise gauge uses gross out");
    assert_eq!(s.tokens_held, 0);
}

#[test]
fn aged_position_sells_tax_free() {
    let mut svm = fresh_svm();
    let t = fair_table(&mut svm);
    open(&mut svm, &t.alice, &t.ka, 1, 3 * LAMPORTS_PER_SOL);
    buy(&mut svm, &t, &t.alice, &t.ka, 1, 2 * LAMPORTS_PER_SOL);

    warp_to(&mut svm, T0 + FLIP_DECAY_SECS); // decay fully elapsed
    let held = read_session(&svm, 1, &t.alice.pubkey()).tokens_held;
    let l = read_launch(&svm, 1);
    let out = sell_quote(l.virtual_sol, l.virtual_tok, held);
    sell(&mut svm, &t, &t.alice, &t.ka, 1, held);

    let s = read_session(&svm, 1, &t.alice.pubkey());
    assert_eq!(s.sol_proceeds, out, "aged out: full proceeds, zero tax");
    assert_eq!(read_launch(&svm, 1).flip_pot, 0, "pot untouched");
}

#[test]
fn weighted_entry_ages_with_the_position() {
    let mut svm = fresh_svm();
    let t = fair_table(&mut svm);
    open(&mut svm, &t.alice, &t.ka, 1, 5 * LAMPORTS_PER_SOL);

    buy(&mut svm, &t, &t.alice, &t.ka, 1, LAMPORTS_PER_SOL);
    warp_to(&mut svm, T0 + 1_000);
    buy(&mut svm, &t, &t.alice, &t.ka, 1, LAMPORTS_PER_SOL);
    let s = read_session(&svm, 1, &t.alice.pubkey());
    assert!(
        s.entry_ts > T0 as u64 && s.entry_ts < (T0 + 1_000) as u64,
        "second buy drags the tokens-weighted entry between the two stamps, got {}",
        s.entry_ts
    );

    // full exit, then a fresh position — the stale stamp must not survive
    sell(&mut svm, &t, &t.alice, &t.ka, 1, s.tokens_held);
    warp_to(&mut svm, T0 + 2_000);
    buy(&mut svm, &t, &t.alice, &t.ka, 1, LAMPORTS_PER_SOL);
    let s = read_session(&svm, 1, &t.alice.pubkey());
    assert_eq!(s.entry_ts, (T0 + 2_000) as u64, "re-entry after full exit resets to now");
}

#[test]
fn flip_pot_ships_with_the_graduation_sweep() {
    let mut svm = fresh_svm();
    let t = fair_table(&mut svm);
    open(&mut svm, &t.alice, &t.ka, 1, 3 * GRADUATION_LAMPORTS / 5);
    open(&mut svm, &t.bob, &t.kb, 1, 7 * GRADUATION_LAMPORTS / 5);

    // alice flips instantly — her tax seeds the pot
    buy(&mut svm, &t, &t.alice, &t.ka, 1, 2 * GRADUATION_LAMPORTS / 5);
    let held = read_session(&svm, 1, &t.alice.pubkey()).tokens_held;
    sell(&mut svm, &t, &t.alice, &t.ka, 1, held);
    let pot = read_launch(&svm, 1).flip_pot;
    assert!(pot > 0, "alice's flip must fund the pot");

    // bob's buy crosses the graduation line — crossing buy freezes the
    // market. Sized to G exactly: alice's flip left only rounding dust in
    // the raise, and the alloc guard leaves ~0.005 SOL of room past G.
    buy(&mut svm, &t, &t.bob, &t.kb, 1, GRADUATION_LAMPORTS);
    let l = read_launch(&svm, 1);
    assert_eq!(l.state, FROZEN);
    assert_eq!(l.flip_pot, pot, "bob never sold — pot unchanged");

    // settle both sessions (both are net losers here; alice's net includes
    // her tax, which is exactly how the lamports reach the launch PDA)
    send(&mut svm, &t.cranker, &[], &[reconcile_ix(&t.alice.pubkey(), 1)]).unwrap();
    send(&mut svm, &t.cranker, &[], &[reconcile_ix(&t.bob.pubkey(), 1)]).unwrap();
    let l = read_launch(&svm, 1);
    assert_eq!(l.state, RECONCILED);

    // the ledger identity WITH tax: signed session nets == raise + pot
    let sa = read_session(&svm, 1, &t.alice.pubkey());
    let sb = read_session(&svm, 1, &t.bob.pubkey());
    let nets = (sa.sol_spent as i128 - sa.sol_proceeds as i128)
        + (sb.sol_spent as i128 - sb.sol_proceeds as i128);
    assert_eq!(nets, l.real_sol_raised as i128 + pot as i128, "conservation incl. tax");

    // graduation drains raise + pot in one sweep — the pot exists to fatten
    // the Meteora seed, not to strand on the PDA
    let launch_before = lamports(&svm, &launch_pda(1));
    let admin_before = lamports(&svm, &t.admin.pubkey());
    send(&mut svm, &t.admin, &[], &[graduate_ix(&t.admin.pubkey(), 1)]).unwrap();
    let sweep = l.real_sol_raised + pot as u64;
    assert_eq!(
        launch_before - lamports(&svm, &launch_pda(1)),
        sweep,
        "launch PDA drained by raise + pot exactly"
    );
    let ata_rent = lamports(&svm, &ata_address(&t.admin.pubkey(), &mint_pda(1)));
    assert_eq!(
        lamports(&svm, &t.admin.pubkey()) - admin_before,
        sweep - 5_000 - ata_rent, // minus tx fee and the admin ATA rent
        "admin receives the full sweep"
    );
    assert_eq!(read_launch(&svm, 1).state, GRADUATED);
}
