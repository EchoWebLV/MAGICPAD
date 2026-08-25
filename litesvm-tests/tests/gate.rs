//! The entry gate: once armed, open_trade_session and top_up_session refuse
//! any transaction the platform gate key did not co-sign. This is the whole
//! "only through our UI" claim, program-enforced. Disarmed (key = default,
//! or the PDA simply not created yet) the door stays permissionless — the
//! pre-gate devnet behavior, and the upgrade path needs no migration.

mod common;

use common::*;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;

fn arm(svm: &mut litesvm::LiteSVM, admin: &Keypair, key: &solana_address::Address) {
    send(svm, admin, &[], &[set_gate_ix(&admin.pubkey(), key)]).expect("set_gate");
}

#[test]
fn gate_off_entry_stays_permissionless() {
    let mut svm = fresh_svm();
    let t = setup_table(&mut svm);
    // no set_gate ever ran — the gate PDA does not even exist
    send(&mut svm, &t.alice, &[], &[
        open_trade_session_ix(&t.alice.pubkey(), 0, &t.ka.pubkey(), LAMPORTS_PER_SOL),
    ])
    .expect("permissionless open while gate PDA absent");
    send(&mut svm, &t.alice, &[&t.ka], &[
        buy_ix(&t.ka.pubkey(), &t.alice.pubkey(), 0, 100_000_000),
    ])
    .expect("buy after permissionless open");
}

#[test]
fn armed_gate_refuses_unsigned_entry() {
    let mut svm = fresh_svm();
    let t = setup_table(&mut svm);
    let gate = Keypair::new();
    arm(&mut svm, &t.admin, &gate.pubkey());

    let res = send(&mut svm, &t.alice, &[], &[
        open_trade_session_ix(&t.alice.pubkey(), 0, &t.ka.pubkey(), LAMPORTS_PER_SOL),
    ]);
    assert_pad_error(res, E_GATE_REQUIRED, "side-wallet open without gate sig");
    assert!(svm.get_account(&session_pda(0, &t.alice.pubkey())).is_none_or(|a| a.data.is_empty()),
        "no session may exist after a refused open");
}

#[test]
fn armed_gate_admits_cosigned_entry() {
    let mut svm = fresh_svm();
    let t = setup_table(&mut svm);
    let gate = Keypair::new();
    arm(&mut svm, &t.admin, &gate.pubkey());

    send(&mut svm, &t.alice, &[&gate], &[
        open_trade_session_gated_ix(&t.alice.pubkey(), 0, &t.ka.pubkey(), LAMPORTS_PER_SOL, &gate.pubkey()),
    ])
    .expect("co-signed open");
    let s = read_session(&svm, 0, &t.alice.pubkey());
    assert_eq!(s.deposit, LAMPORTS_PER_SOL);

    // trading itself needs no gate — the session IS the proof of entry
    send(&mut svm, &t.alice, &[&t.ka], &[
        buy_ix(&t.ka.pubkey(), &t.alice.pubkey(), 0, 100_000_000),
    ])
    .expect("buy on a gated-open session");
}

#[test]
fn armed_gate_refuses_wrong_cosigner() {
    let mut svm = fresh_svm();
    let t = setup_table(&mut svm);
    let gate = Keypair::new();
    let impostor = Keypair::new();
    arm(&mut svm, &t.admin, &gate.pubkey());

    let res = send(&mut svm, &t.alice, &[&impostor], &[
        open_trade_session_gated_ix(&t.alice.pubkey(), 0, &t.ka.pubkey(), LAMPORTS_PER_SOL, &impostor.pubkey()),
    ]);
    assert_pad_error(res, E_GATE_REQUIRED, "an impostor signature is not the gate");
}

#[test]
fn armed_gate_gates_topups_too() {
    let mut svm = fresh_svm();
    let t = setup_table(&mut svm);
    let gate = Keypair::new();
    arm(&mut svm, &t.admin, &gate.pubkey());

    send(&mut svm, &t.alice, &[&gate], &[
        open_trade_session_gated_ix(&t.alice.pubkey(), 0, &t.ka.pubkey(), LAMPORTS_PER_SOL, &gate.pubkey()),
    ])
    .expect("co-signed open");

    // the size-policy back door: blessed once, grow forever? no.
    let res = send(&mut svm, &t.alice, &[], &[
        top_up_session_ix(&t.alice.pubkey(), 0, 1, MIN_DEPOSIT),
    ]);
    assert_pad_error(res, E_GATE_REQUIRED, "top-up without gate sig");

    send(&mut svm, &t.alice, &[&gate], &[
        top_up_session_gated_ix(&t.alice.pubkey(), 0, 1, MIN_DEPOSIT, &gate.pubkey()),
    ])
    .expect("co-signed top-up");
}

#[test]
fn only_admin_holds_the_gate() {
    let mut svm = fresh_svm();
    let t = setup_table(&mut svm);
    let gate = Keypair::new();
    let res = send(&mut svm, &t.alice, &[], &[set_gate_ix(&t.alice.pubkey(), &gate.pubkey())]);
    assert_pad_error(res, E_UNAUTHORIZED, "stranger arming the gate");
}

#[test]
fn disarming_reopens_the_door() {
    let mut svm = fresh_svm();
    let t = setup_table(&mut svm);
    let gate = Keypair::new();
    arm(&mut svm, &t.admin, &gate.pubkey());
    arm(&mut svm, &t.admin, &solana_address::Address::default()); // kill-switch

    send(&mut svm, &t.alice, &[], &[
        open_trade_session_ix(&t.alice.pubkey(), 0, &t.ka.pubkey(), LAMPORTS_PER_SOL),
    ])
    .expect("permissionless open after disarm");
}

#[test]
fn forged_gate_account_is_pinned_out() {
    let mut svm = fresh_svm();
    let t = setup_table(&mut svm);
    let gate = Keypair::new();
    arm(&mut svm, &t.admin, &gate.pubkey());

    // hand-build the open with a NON-canonical gate account: an attacker
    // pointing the ix at data they control instead of the gate PDA
    let fake = Keypair::new();
    let mut ix = open_trade_session_ix(&t.alice.pubkey(), 0, &t.ka.pubkey(), LAMPORTS_PER_SOL);
    let n = ix.accounts.len();
    ix.accounts[n - 2] = AccountMeta::new_readonly(fake.pubkey(), false);
    let res = send(&mut svm, &t.alice, &[], &[ix]);
    assert!(res.is_err(), "a non-canonical gate account must not pass the seeds check");
    assert!(svm.get_account(&session_pda(0, &t.alice.pubkey())).is_none_or(|a| a.data.is_empty()),
        "no session may exist after the forgery attempt");
}

#[test]
fn gate_state_reads_back() {
    let mut svm = fresh_svm();
    let t = setup_table(&mut svm);
    let gate = Keypair::new();
    arm(&mut svm, &t.admin, &gate.pubkey());
    let g: GateMirror = read_account(&svm, &gate_pda());
    assert_eq!(g.key, gate.pubkey().to_bytes());
}
