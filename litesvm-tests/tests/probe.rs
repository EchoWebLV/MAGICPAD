//! Review probes. Bug 1 (lock_mint griefing unclaimed claims) is inverted
//! to the fixed behaviour. Bug 2 (rakeback partial-claim) went away with
//! the instruction — the discriminator must no longer land.

mod common;
use common::*;
use solana_instruction::{AccountMeta, Instruction};
use solana_signer::Signer;

/// lock_mint requires supply == TOKEN_TOTAL_SUPPLY, which is only true
/// after every claim has minted AND graduate has minted the leftover.
/// A stranger cannot brick outstanding claims.
#[test]
fn lock_mint_refuses_while_claims_outstanding() {
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

    send(&mut svm, &t.cranker, &[], &[reconcile_ix(&t.alice.pubkey(), 0)]).unwrap();
    send(&mut svm, &t.cranker, &[], &[reconcile_ix(&t.bob.pubkey(), 0)]).unwrap();

    send(&mut svm, &t.cranker, &[], &[claim_tokens_ix(&t.cranker.pubkey(), &t.alice.pubkey(), 0)]).unwrap();
    let bob_owed = read_session(&svm, 0, &t.bob.pubkey()).tokens_held;
    assert!(bob_owed > 0, "bob has an outstanding claim");
    assert!(!read_session(&svm, 0, &t.bob.pubkey()).tokens_claimed);

    send(&mut svm, &t.admin, &[], &[graduate_ix(&t.admin.pubkey(), 0)]).unwrap();
    assert_eq!(read_launch(&svm, 0).state, GRADUATED);
    assert!(
        mint_supply(&svm, &mint_pda(0)) < TOKEN_TOTAL_SUPPLY,
        "bob's unclaimed bag keeps supply below TOTAL"
    );

    assert_pad_error(
        send(&mut svm, &t.cranker, &[], &[lock_mint_ix(0)]),
        E_MINT_NOT_READY,
        "lock_mint while bob is still owed tokens",
    );
    assert_eq!(mint_authority_opt(&svm, &mint_pda(0)), Some(platform_pda()));

    send(&mut svm, &t.cranker, &[], &[claim_tokens_ix(&t.cranker.pubkey(), &t.bob.pubkey(), 0)]).unwrap();
    assert_eq!(
        token_amount(&svm, &ata_address(&t.bob.pubkey(), &mint_pda(0))),
        bob_owed,
        "bob receives the tokens he paid 2.6 SOL for",
    );
    assert_eq!(mint_supply(&svm, &mint_pda(0)), TOKEN_TOTAL_SUPPLY);

    send(&mut svm, &t.cranker, &[], &[lock_mint_ix(0)]).unwrap();
    assert_eq!(mint_authority_opt(&svm, &mint_pda(0)), None);
}

#[test]
fn rakeback_instructions_are_gone() {
    let mut svm = fresh_svm();
    let t = setup_table(&mut svm);
    let gone = |name: &str, accounts: Vec<AccountMeta>, args: Vec<u8>| Instruction {
        program_id: program_id(),
        accounts,
        data: {
            let mut d = ix_data_empty(name);
            d.extend(args);
            d
        },
    };
    assert!(
        send(
            &mut svm,
            &t.admin,
            &[],
            &[gone(
                "fund_rakeback",
                vec![
                    AccountMeta::new(t.admin.pubkey(), true),
                    AccountMeta::new(platform_pda(), false),
                    AccountMeta::new_readonly(system_id(), false),
                ],
                1_000u64.to_le_bytes().to_vec(),
            )],
        )
        .is_err(),
        "fund_rakeback discriminator must not land",
    );
    assert!(
        send(
            &mut svm,
            &t.cranker,
            &[],
            &[gone(
                "claim_rakeback",
                vec![
                    AccountMeta::new(t.alice.pubkey(), false),
                    AccountMeta::new(session_pda(0, &t.alice.pubkey()), false),
                    AccountMeta::new(platform_pda(), false),
                ],
                vec![],
            )],
        )
        .is_err(),
        "claim_rakeback discriminator must not land",
    );
}
