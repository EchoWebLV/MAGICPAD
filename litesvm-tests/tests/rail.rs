//! Full rail lifecycle on L1 — same ledger logic the ER runs, minus the
//! delegation transport (stakehouse testing precedent). The load-bearing
//! assert is CONSERVATION: Σ session nets == real_sol_raised == the exact
//! lamports the launch pot gains. If that holds, the rail can't mint or
//! leak money no matter what the rollup did.

mod common;
use common::*;
use solana_signer::Signer;

#[test]
fn create_launch_takes_fee_and_makes_mint() {
    let mut svm = fresh_svm();
    let admin = solana_keypair::Keypair::new();
    let creator = solana_keypair::Keypair::new();
    for k in [&admin, &creator] {
        svm.airdrop(&k.pubkey(), 10 * LAMPORTS_PER_SOL).unwrap();
    }
    send(&mut svm, &admin, &[], &[init_platform_ix(&admin.pubkey())]).unwrap();

    let platform_before = lamports(&svm, &platform_pda());
    send(
        &mut svm,
        &creator,
        &[],
        &[create_launch_ix(&creator.pubkey(), 0, "DARKPAD", "DARK")],
    )
    .unwrap();

    // the 1 SOL gate landed on the platform, to the lamport
    assert_eq!(
        lamports(&svm, &platform_pda()) - platform_before,
        LAUNCH_FEE_LAMPORTS,
        "platform did not receive exactly the launch fee"
    );

    let p: PlatformMirror = read_account(&svm, &platform_pda());
    assert_eq!(p.launch_seq, 1, "launch_seq must bump");

    let l = read_launch(&svm, 0);
    assert_eq!(l.id, 0);
    assert_eq!(l.state, BONDING);
    assert_eq!(l.virtual_sol, VIRTUAL_SOL_INIT);
    assert_eq!(l.virtual_tok, VIRTUAL_TOK_INIT);
    assert_eq!(l.real_sol_raised, 0);
    assert_eq!(l.creator, creator.pubkey().to_bytes());
    assert_eq!(l.mint, mint_pda(0).to_bytes());
    assert_eq!(l.first_window_end_ts, l.created_ts + FIRST_WINDOW_SECS);

    // dark bonding: the mint exists, supply ZERO, authority = platform PDA
    assert_eq!(mint_supply(&svm, &mint_pda(0)), 0, "no supply until claims");
    assert_eq!(mint_decimals(&svm, &mint_pda(0)), 6);
    assert_eq!(mint_authority(&svm, &mint_pda(0)), platform_pda());

    // a second launch of the same name is a different id — seq-seeded
    send(
        &mut svm,
        &creator,
        &[],
        &[create_launch_ix(&creator.pubkey(), 1, "DARKPAD", "DARK")],
    )
    .unwrap();
    assert_eq!(read_launch(&svm, 1).id, 1);

    // metadata gates
    let too_long = "X".repeat(33);
    assert_pad_error(
        send(&mut svm, &creator, &[], &[create_launch_ix(&creator.pubkey(), 2, &too_long, "OK")]),
        E_BAD_METADATA,
        "33-char name",
    );
}

#[test]
fn full_lifecycle_two_traders() {
    let mut svm = fresh_svm();
    let t = setup_table(&mut svm);
    warp_past_window(&mut svm);

    // one L1 approval each: escrow the bankroll, pin the session key
    send(
        &mut svm,
        &t.alice,
        &[],
        &[open_trade_session_ix(&t.alice.pubkey(), 0, &t.ka.pubkey(), 3 * LAMPORTS_PER_SOL)],
    )
    .unwrap();
    send(
        &mut svm,
        &t.bob,
        &[],
        &[open_trade_session_ix(&t.bob.pubkey(), 0, &t.kb.pubkey(), 3 * LAMPORTS_PER_SOL)],
    )
    .unwrap();
    // escrow really landed in the session PDAs
    let s_alice = session_pda(0, &t.alice.pubkey());
    assert!(lamports(&svm, &s_alice) > 3 * LAMPORTS_PER_SOL, "deposit escrowed");

    // gasless lane: the session KEYS sign, the cranker pays fees
    let a_buy = 2_500_000_000u64;
    let b_buy = 2_600_000_000u64; // the crossing buy: 2.5 + 2.6 >= 5 SOL
    let l0 = read_launch(&svm, 0);
    let a_expected = buy_quote(l0.virtual_sol, l0.virtual_tok, a_buy);
    send(&mut svm, &t.cranker, &[&t.ka], &[buy_ix(&t.ka.pubkey(), &t.alice.pubkey(), 0, a_buy)])
        .unwrap();
    let l1 = read_launch(&svm, 0);
    assert_eq!(l1.state, BONDING, "2.5 SOL does not graduate yet");
    let b_expected = buy_quote(l1.virtual_sol, l1.virtual_tok, b_buy);
    send(&mut svm, &t.cranker, &[&t.kb], &[buy_ix(&t.kb.pubkey(), &t.bob.pubkey(), 0, b_buy)])
        .unwrap();

    // the crossing buy froze the market — graduation is a state, not a race
    let l = read_launch(&svm, 0);
    assert_eq!(l.state, FROZEN, "crossing buy must freeze");
    assert_eq!(l.real_sol_raised, a_buy + b_buy);
    assert_eq!(l.sessions_opened, 2);
    assert_eq!(l.tokens_sold, a_expected + b_expected);

    let sa = read_session(&svm, 0, &t.alice.pubkey());
    assert_eq!(sa.tokens_held, a_expected, "quote math must match on-chain");
    assert_eq!(sa.sol_spent, a_buy);

    // cash follows ledger: permissionless reconcile, cranker pays the fee
    let launch_before = lamports(&svm, &launch_pda(0));
    let alice_before = lamports(&svm, &t.alice.pubkey());
    let bob_before = lamports(&svm, &t.bob.pubkey());
    send(&mut svm, &t.cranker, &[], &[reconcile_ix(&t.alice.pubkey(), 0)]).unwrap();
    send(&mut svm, &t.cranker, &[], &[reconcile_ix(&t.bob.pubkey(), 0)]).unwrap();

    // CONSERVATION — the load-bearing assert of the whole rail:
    // launch pot gained exactly Σ nets == real_sol_raised, refunds exact
    assert_eq!(
        lamports(&svm, &launch_pda(0)) - launch_before,
        a_buy + b_buy,
        "pot must gain exactly the sum of session nets"
    );
    assert_eq!(
        lamports(&svm, &t.alice.pubkey()) - alice_before,
        3 * LAMPORTS_PER_SOL - a_buy,
        "alice refund = deposit - net, to the lamport"
    );
    assert_eq!(
        lamports(&svm, &t.bob.pubkey()) - bob_before,
        3 * LAMPORTS_PER_SOL - b_buy,
        "bob refund = deposit - net, to the lamport"
    );
    let l = read_launch(&svm, 0);
    assert_eq!(l.state, RECONCILED, "all counted sessions reconciled");

    // double reconcile is dead
    assert_pad_error(
        send(&mut svm, &t.cranker, &[], &[reconcile_ix(&t.alice.pubkey(), 0)]),
        E_ALREADY_RECONCILED,
        "double reconcile",
    );

    // dark bonding ends: claims mint the FIRST tokens this mint ever sees
    send(&mut svm, &t.cranker, &[], &[claim_tokens_ix(&t.cranker.pubkey(), &t.alice.pubkey(), 0)])
        .unwrap();
    let alice_ata = ata_address(&t.alice.pubkey(), &mint_pda(0));
    assert_eq!(token_amount(&svm, &alice_ata), a_expected, "claim mints exactly tokens_held");
    send(&mut svm, &t.cranker, &[], &[claim_tokens_ix(&t.cranker.pubkey(), &t.bob.pubkey(), 0)])
        .unwrap();
    assert_eq!(
        mint_supply(&svm, &mint_pda(0)),
        l.tokens_sold,
        "supply after claims == tokens_sold exactly"
    );
    assert_pad_error(
        send(&mut svm, &t.cranker, &[], &[claim_tokens_ix(&t.cranker.pubkey(), &t.alice.pubkey(), 0)]),
        E_ALREADY_CLAIMED,
        "double token claim",
    );

    // loud graduation: pot + unsold supply leave for the Meteora seed
    let admin_before = lamports(&svm, &t.admin.pubkey());
    send(&mut svm, &t.admin, &[], &[graduate_ix(&t.admin.pubkey(), 0)]).unwrap();
    let l = read_launch(&svm, 0);
    assert_eq!(l.state, GRADUATED);
    let admin_ata = ata_address(&t.admin.pubkey(), &mint_pda(0));
    assert_eq!(
        token_amount(&svm, &admin_ata),
        TOKEN_TOTAL_SUPPLY - l.tokens_sold,
        "LP side gets exactly the unsold supply"
    );
    assert_eq!(
        mint_supply(&svm, &mint_pda(0)),
        TOKEN_TOTAL_SUPPLY,
        "claims + graduation mint == total supply, no more, no less"
    );
    // pot moved to the migration wallet (admin paid tx fee + maybe ATA rent)
    assert!(
        lamports(&svm, &t.admin.pubkey()) > admin_before + (a_buy + b_buy) - 10_000_000,
        "graduation hands the raised SOL to the migration wallet"
    );
}

#[test]
fn sell_realizes_loss_and_rakeback_pays() {
    let mut svm = fresh_svm();
    let t = setup_table(&mut svm);
    warp_past_window(&mut svm);
    // the rakeback pool exists and gets funded (v2: platform token fees)
    send(&mut svm, &t.admin, &[], &[fund_rakeback_ix(&t.admin.pubkey(), LAMPORTS_PER_SOL)]).unwrap();

    for (who, key) in [(&t.alice, &t.ka), (&t.bob, &t.kb)] {
        send(
            &mut svm,
            who,
            &[],
            &[open_trade_session_ix(&who.pubkey(), 0, &key.pubkey(), 3 * LAMPORTS_PER_SOL)],
        )
        .unwrap();
    }

    // bob buys early, alice buys late (higher entry), bob dumps, alice
    // exits into the crater — a real realized loss, not rounding dust
    send(&mut svm, &t.cranker, &[&t.kb], &[buy_ix(&t.kb.pubkey(), &t.bob.pubkey(), 0, 2 * LAMPORTS_PER_SOL)]).unwrap();
    send(&mut svm, &t.cranker, &[&t.ka], &[buy_ix(&t.ka.pubkey(), &t.alice.pubkey(), 0, LAMPORTS_PER_SOL)]).unwrap();
    let bob_tokens = read_session(&svm, 0, &t.bob.pubkey()).tokens_held;
    send(&mut svm, &t.cranker, &[&t.kb], &[sell_ix(&t.kb.pubkey(), &t.bob.pubkey(), 0, bob_tokens)]).unwrap();
    let alice_tokens = read_session(&svm, 0, &t.alice.pubkey()).tokens_held;
    send(&mut svm, &t.cranker, &[&t.ka], &[sell_ix(&t.ka.pubkey(), &t.alice.pubkey(), 0, alice_tokens)]).unwrap();

    let sa = read_session(&svm, 0, &t.alice.pubkey());
    let sb = read_session(&svm, 0, &t.bob.pubkey());
    assert!(sa.realized_loss > 10_000_000, "alice took a real loss, got {}", sa.realized_loss);
    assert_eq!(sb.realized_loss, 0, "bob sold at profit — no loss ledger");
    assert!(sb.sol_proceeds > sb.sol_spent, "bob is a net winner");

    // conservation with sells: Σ signed nets == real_sol_raised
    let l = read_launch(&svm, 0);
    let net_a = sa.sol_spent as i128 - sa.sol_proceeds as i128;
    let net_b = sb.sol_spent as i128 - sb.sol_proceeds as i128;
    assert_eq!(net_a + net_b, l.real_sol_raised as i128, "signed conservation");

    // fizzle path: admin freezes a market that will never graduate
    send(&mut svm, &t.admin, &[], &[freeze_launch_ix(&t.admin.pubkey(), 0)]).unwrap();

    // winner-first reconcile must FAIL-AND-RETRY: pot not funded yet
    assert_pad_error(
        send(&mut svm, &t.cranker, &[], &[reconcile_ix(&t.bob.pubkey(), 0)]),
        E_POT_NOT_READY,
        "winner before losers",
    );
    // loser lands, then the winner's profit is covered
    let alice_before = lamports(&svm, &t.alice.pubkey());
    let bob_before = lamports(&svm, &t.bob.pubkey());
    send(&mut svm, &t.cranker, &[], &[reconcile_ix(&t.alice.pubkey(), 0)]).unwrap();
    send(&mut svm, &t.cranker, &[], &[reconcile_ix(&t.bob.pubkey(), 0)]).unwrap();
    assert_eq!(
        lamports(&svm, &t.alice.pubkey()) - alice_before,
        (3 * LAMPORTS_PER_SOL as i128 - net_a) as u64,
        "loser refund exact"
    );
    assert_eq!(
        lamports(&svm, &t.bob.pubkey()) - bob_before,
        (3 * LAMPORTS_PER_SOL as i128 + (-net_b)) as u64,
        "winner gets deposit + profit exact"
    );

    // the negative fee: 10% of realized losses back, from the pool
    let alice_before = lamports(&svm, &t.alice.pubkey());
    let pool_before = lamports(&svm, &rakeback_pda());
    send(&mut svm, &t.cranker, &[], &[claim_rakeback_ix(&t.alice.pubkey(), 0)]).unwrap();
    let paid = lamports(&svm, &t.alice.pubkey()) - alice_before;
    assert_eq!(paid, sa.realized_loss * RAKEBACK_BPS / 10_000, "rakeback = loss x 10%");
    assert_eq!(pool_before - lamports(&svm, &rakeback_pda()), paid, "paid from the pool");
    assert_pad_error(
        send(&mut svm, &t.cranker, &[], &[claim_rakeback_ix(&t.alice.pubkey(), 0)]),
        E_ALREADY_CLAIMED,
        "double rakeback",
    );
    assert_pad_error(
        send(&mut svm, &t.cranker, &[], &[claim_rakeback_ix(&t.bob.pubkey(), 0)]),
        E_NOTHING_TO_CLAIM,
        "winners have no loss to rake back",
    );

    // a fizzled market never graduates
    assert_pad_error(
        send(&mut svm, &t.admin, &[], &[graduate_ix(&t.admin.pubkey(), 0)]),
        E_NOT_GRADUATABLE,
        "under threshold",
    );
}

#[test]
fn first_window_cap_enforced() {
    let mut svm = fresh_svm();
    let t = setup_table(&mut svm);
    // NO warp — we are inside the first window on purpose
    send(
        &mut svm,
        &t.alice,
        &[],
        &[open_trade_session_ix(&t.alice.pubkey(), 0, &t.ka.pubkey(), 2 * LAMPORTS_PER_SOL)],
    )
    .unwrap();

    // 0.6 SOL in the window: over the 0.5 cap
    assert_pad_error(
        send(&mut svm, &t.cranker, &[&t.ka], &[buy_ix(&t.ka.pubkey(), &t.alice.pubkey(), 0, 600_000_000)]),
        E_FIRST_WINDOW_CAP,
        "single over-cap buy",
    );
    // 0.3 then 0.3: the SECOND crosses the gross cap
    send(&mut svm, &t.cranker, &[&t.ka], &[buy_ix(&t.ka.pubkey(), &t.alice.pubkey(), 0, 300_000_000)]).unwrap();
    assert_pad_error(
        send(&mut svm, &t.cranker, &[&t.ka], &[buy_ix(&t.ka.pubkey(), &t.alice.pubkey(), 0, 300_000_000)]),
        E_FIRST_WINDOW_CAP,
        "gross cap across buys",
    );
    // window over → the cap lifts
    warp_past_window(&mut svm);
    send(&mut svm, &t.cranker, &[&t.ka], &[buy_ix(&t.ka.pubkey(), &t.alice.pubkey(), 0, LAMPORTS_PER_SOL)]).unwrap();
    assert_eq!(read_session(&svm, 0, &t.alice.pubkey()).sol_spent, 1_300_000_000);
}

#[test]
fn escrow_discipline_and_hijack_resistance() {
    let mut svm = fresh_svm();
    let t = setup_table(&mut svm);
    warp_past_window(&mut svm);

    // deposit floor
    assert_pad_error(
        send(
            &mut svm,
            &t.alice,
            &[],
            &[open_trade_session_ix(&t.alice.pubkey(), 0, &t.ka.pubkey(), MIN_DEPOSIT - 1)],
        ),
        E_DEPOSIT_TOO_SMALL,
        "dust deposit",
    );

    send(
        &mut svm,
        &t.alice,
        &[],
        &[open_trade_session_ix(&t.alice.pubkey(), 0, &t.ka.pubkey(), LAMPORTS_PER_SOL)],
    )
    .unwrap();

    // net exposure can never pass the escrow
    assert_pad_error(
        send(&mut svm, &t.cranker, &[&t.ka], &[buy_ix(&t.ka.pubkey(), &t.alice.pubkey(), 0, LAMPORTS_PER_SOL + 1)]),
        E_EXCEEDS_DEPOSIT,
        "single over-deposit buy",
    );
    send(&mut svm, &t.cranker, &[&t.ka], &[buy_ix(&t.ka.pubkey(), &t.alice.pubkey(), 0, 800_000_000)]).unwrap();
    assert_pad_error(
        send(&mut svm, &t.cranker, &[&t.ka], &[buy_ix(&t.ka.pubkey(), &t.alice.pubkey(), 0, 300_000_000)]),
        E_EXCEEDS_DEPOSIT,
        "cumulative over-deposit buy",
    );

    // a stranger's key cannot drive alice's session
    let mallory = solana_keypair::Keypair::new();
    assert_pad_error(
        send(&mut svm, &t.cranker, &[&mallory], &[buy_ix(&mallory.pubkey(), &t.alice.pubkey(), 0, 1_000_000)]),
        E_SESSION_KEY_MISMATCH,
        "hijacked signer",
    );

    // selling tokens you don't hold is dead
    assert_pad_error(
        send(
            &mut svm,
            &t.cranker,
            &[&t.ka],
            &[sell_ix(&t.ka.pubkey(), &t.alice.pubkey(), 0, u64::MAX / 2)],
        ),
        E_INSUFFICIENT_TOKENS,
        "oversell",
    );

    // reconcile pays ONLY the recorded trader: wrong payout target fails
    send(&mut svm, &t.admin, &[], &[freeze_launch_ix(&t.admin.pubkey(), 0)]).unwrap();
    let mut bad = reconcile_ix(&t.alice.pubkey(), 0);
    bad.accounts[0] = solana_instruction::AccountMeta::new(mallory.pubkey(), false);
    assert_pad_error(
        send(&mut svm, &t.cranker, &[], &[bad]),
        E_UNAUTHORIZED,
        "stranger redirecting a refund",
    );
}

#[test]
fn no_trades_after_freeze() {
    let mut svm = fresh_svm();
    let t = setup_table(&mut svm);
    warp_past_window(&mut svm);
    for (who, key) in [(&t.alice, &t.ka), (&t.bob, &t.kb)] {
        send(
            &mut svm,
            who,
            &[],
            &[open_trade_session_ix(&who.pubkey(), 0, &key.pubkey(), 3 * LAMPORTS_PER_SOL)],
        )
        .unwrap();
    }
    send(&mut svm, &t.cranker, &[&t.ka], &[buy_ix(&t.ka.pubkey(), &t.alice.pubkey(), 0, 2_500_000_000)]).unwrap();
    send(&mut svm, &t.cranker, &[&t.kb], &[buy_ix(&t.kb.pubkey(), &t.bob.pubkey(), 0, 2_600_000_000)]).unwrap();
    assert_eq!(read_launch(&svm, 0).state, FROZEN);

    // the market is frozen for EVERYTHING: buys, sells, late sessions
    assert_pad_error(
        send(&mut svm, &t.cranker, &[&t.ka], &[buy_ix(&t.ka.pubkey(), &t.alice.pubkey(), 0, 1_000_000)]),
        E_LAUNCH_NOT_BONDING,
        "buy after freeze",
    );
    assert_pad_error(
        send(&mut svm, &t.cranker, &[&t.ka], &[sell_ix(&t.ka.pubkey(), &t.alice.pubkey(), 0, 1)]),
        E_LAUNCH_NOT_BONDING,
        "sell after freeze",
    );
    let late = solana_keypair::Keypair::new();
    svm.airdrop(&late.pubkey(), 5 * LAMPORTS_PER_SOL).unwrap();
    assert_pad_error(
        send(
            &mut svm,
            &late,
            &[],
            &[open_trade_session_ix(&late.pubkey(), 0, &t.ka.pubkey(), LAMPORTS_PER_SOL)],
        ),
        E_LAUNCH_NOT_BONDING,
        "session after freeze",
    );

    // claims before reconcile are dead
    assert_pad_error(
        send(&mut svm, &t.cranker, &[], &[claim_tokens_ix(&t.cranker.pubkey(), &t.alice.pubkey(), 0)]),
        E_NOT_RECONCILED,
        "claim before reconcile",
    );
    // and graduation before settlement is dead
    assert_pad_error(
        send(&mut svm, &t.admin, &[], &[graduate_ix(&t.admin.pubkey(), 0)]),
        E_NOT_GRADUATABLE,
        "graduate before reconcile",
    );
}
