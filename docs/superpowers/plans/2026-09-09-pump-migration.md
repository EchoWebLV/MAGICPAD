# pump.fun Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-launch "pump mode" where the dark Mooner round freezes at 1 SOL and a CLI moves every holder onto pump.fun through program-signed `buy`s, so the resulting holder map has no transfer edges and no deployer hub.

**Architecture:** A separate `PumpLaunch` PDA (`["pump", launch_id]`) is the on-chain switch: `buy` reads it as a trailing optional account to pick the 1 SOL line, and `claim_tokens`/`graduate` refuse when it exists. Three new instructions do the migration: `set_pump_mint` records the pump.fun mint the CLI created (creator = `launch.creator`), `pump_claim` funds a per-session vault PDA from the launch pot and CPIs pump.fun `buy` with the vault as `user` and the trader's ATA as `associated_user`, and `pump_graduate` spends the remainder into a burn buy, sweeps residue to the platform, revokes the Mooner mint authority, and marks GRADUATED. `scripts/migrate-pump.mjs` (dry by default, `--confirm` sends, the user runs it) creates the pump token, sets the mint, computes each holder's pro-rata amount, and cranks the claims.

**Tech Stack:** Anchor 1.0.2 (`anchor-lang` with `init-if-needed` + `allow-missing-optionals`), `anchor-spl` 1.0.2, litesvm 0.13.1 integration tests with mainnet pump.fun fixtures, Node 22 ESM scripts, `@pump-fun/pump-sdk@1.36.0` (CJS), Next.js web (`apps/web`).

Spec: `docs/superpowers/specs/2026-09-09-pump-migration-design.md` — the hard facts (18-account `buy`, discriminators, rent numbers, fee tiers) live there and are repeated inline where a task needs them.

---

## Conventions every task follows

- Work on branch `pump-migration` (already checked out). Commit after every task with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Program tests: `anchor build` first (writes `target/deploy/magicpad.so` + `target/idl/magicpad.json`), then `cd litesvm-tests && cargo test`. Every `test result:` line must read `ok` with `0 failed`.
- Program unit tests (pure, no accounts): `cargo test --manifest-path programs/magicpad/Cargo.toml --lib`.
- Error codes are append-only. New ones are 6024..6032; the harness mirrors them as `E_*` constants.
- pump.fun fixtures live in `litesvm-tests/fixtures/` (gitignored). Tests that need them call `load_pump(&mut svm)` and `return` when it yields `None`, printing a notice — they are skipped, not failed, on a machine without fixtures. Task 0 captures them once.
- Never run `scripts/migrate-pump.mjs --confirm`. The user sends the spend. The executor runs `--dry` only.
- `scripts/mainnet-canary/` is gitignored and never edited by this plan.

## File map

| File | Responsibility |
|---|---|
| `programs/magicpad/src/constants.rs` | `PUMP_SEED`, `PUMP_VAULT_SEED`, `PUMP_GRADUATION_LAMPORTS`, `PUMP_HAIRCUT_BPS` |
| `programs/magicpad/src/state.rs` | `PumpLaunch` account |
| `programs/magicpad/src/error.rs` | errors 6024..6032 |
| `programs/magicpad/src/pump_cpi.rs` (new) | pure pump.fun shapes: program ids, discriminators, `buy` data + 18-meta instruction builder, `close_user_volume_accumulator` builder, bonding-curve head parser |
| `programs/magicpad/src/instructions/pump.rs` (new) | `EnablePump`, `SetPumpMint`, `PumpClaim`, `PumpGraduate` + handlers |
| `programs/magicpad/src/instructions/trade.rs` | `BuyEr` (trailing optional `pump`), threshold switch |
| `programs/magicpad/src/instructions/reconcile.rs` | empty-PDA guard on `ClaimTokens` / `Graduate` |
| `programs/magicpad/src/lib.rs` | instruction entry points |
| `programs/magicpad/Cargo.toml` | `allow-missing-optionals` feature |
| `litesvm-tests/tests/common/pump.rs` (new) | fixture loader, pump PDAs, raw pump `buy` / close builders, `pump_claim_ix` / `pump_graduate_ix` |
| `litesvm-tests/tests/common/mod.rs` | `pump_pda`, vault PDAs, `enable_pump_ix`, `buy_ix_pump`, `set_pump_mint_ix`, `PumpLaunchMirror`, `E_PUMP_*`, `pump` account on `claim_tokens_ix` / `graduate_ix` |
| `litesvm-tests/tests/pump_spike.rs` (new) | proves the mainnet pump ELF runs under litesvm and a PDA-free keypair buy lands in a foreign ATA |
| `litesvm-tests/tests/pump.rs` (new) | lifecycle + error tests for the four instructions and the guards |
| `scripts/dump-pump-fixtures.mjs` (new) | captures pump/pfee ELFs + accounts + a simulated post-`create` curve into `litesvm-tests/fixtures/` |
| `scripts/migrate-pump.mjs` (new) | the migration CLI |
| `scripts/migrate.mjs` | exports `loadKeeper`/`readRecord`/`writeRecord`; skips pump launches |
| `scripts/keeper.mjs` | skips claim/graduate/migrate for pump launches; passes `pump` to `claimTokens`/`graduate` |
| `scripts/fair-canary.mjs`, `scripts/demo-trader.mjs` | pass `pump` to `claimTokens`/`graduate` |
| `apps/web/lib/core.ts` | `pumpPda`, `PUMP_GRADUATION_LAMPORTS`, `pumpUrl` |
| `apps/web/lib/magicpad.ts` | `decodePumpLaunch`, `LaunchView.pump/pumpMint`, `graduationFor` |
| `apps/web/lib/trade-live.ts` | `isPumpLaunch`, `readPumpLaunch`, `buyLive` passes `pump`, `claimTokens` passes `pump` |
| `apps/web/lib/paint-trade.ts`, `apps/web/lib/receipt.ts` | threshold via `graduationFor` / pump PDA check |
| `apps/web/app/create/page.tsx` | "graduate on pump.fun at 1◎" checkbox → `enable_pump` in the creation tx |
| `apps/web/app/launch/[id]/page.tsx`, `apps/web/components/Board.tsx`, `apps/web/components/Featured.tsx`, `apps/web/app/page.tsx` | pump-aware progress, chips, links, no claim button |
| `apps/web/lib/idl-v3.json` | regenerated IDL |
| `.gitignore`, `package.json` | fixtures + mint keypairs ignored; `migrate-pump` script; SDK dep |

---

### Task 0: Groundwork — ignores, feature flag, SDK dep, fixture capture

**Files:**
- Modify: `.gitignore`
- Modify: `programs/magicpad/Cargo.toml:22`
- Modify: `package.json`
- Create: `scripts/dump-pump-fixtures.mjs`

- [ ] **Step 1: Ignore the fixture and mint-keypair directories**

Append to `.gitignore`:

```gitignore

# pump.fun mainnet fixtures for litesvm (10 MB ELF) — captured locally by scripts/dump-pump-fixtures.mjs
litesvm-tests/fixtures/
# pump.fun mint keypairs — the CA is known before launch, the secret never leaves this machine
scripts/pump-mints/
```

Run: `git check-ignore -v litesvm-tests/fixtures/pump.so scripts/pump-mints/0.json`
Expected: two lines, each naming `.gitignore` as the matching source.

- [ ] **Step 2: Enable trailing-optional tolerance in anchor-lang**

In `programs/magicpad/Cargo.toml` replace

```toml
anchor-lang = { version = "=1.0.2", features = ["init-if-needed"] }
```

with

```toml
# allow-missing-optionals: a trailing Option<Account> may be OMITTED from the
# tx (→ None) instead of erroring with AccountNotEnoughKeys. Existing
# 3-account buy/sell txs and the devnet IDL keep working once `buy` grows an
# optional `pump` account (Task 4).
anchor-lang = { version = "=1.0.2", features = ["init-if-needed", "allow-missing-optionals"] }
```

Run: `anchor build 2>&1 | tail -3`
Expected: exit code 0 and no `error` in the output (anchor-cli 0.31.1 prints no "Writing idl" line — confirm the build by `target/idl/magicpad.json`'s mtime being fresh). If cargo reports the feature does not exist, stop — the plan depends on `anchor-lang` 1.0.2 exposing `allow-missing-optionals` (verified in `~/.cargo/registry/src/*/anchor-lang-1.0.2/Cargo.toml`).

- [ ] **Step 3: Add the pump SDK and the CLI script entry**

Run: `pnpm add -w @pump-fun/pump-sdk@1.36.0`
Expected: `package.json` `dependencies` gains `"@pump-fun/pump-sdk": "1.36.0"` (pnpm may write `^1.36.0` — pin it to `1.36.0` by hand if so).

Then edit `package.json` `scripts` to:

```json
  "scripts": {
    "demo": "node scripts/demo-trader.mjs",
    "keeper": "node scripts/keeper.mjs",
    "migrate": "node scripts/migrate.mjs",
    "migrate-pump": "node scripts/migrate-pump.mjs"
  },
```

Run: `node -e "const s=require('@pump-fun/pump-sdk'); console.log(typeof s.PumpSdk, s.PUMP_PROGRAM_ID.toBase58())"`
Expected: `function 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`

- [ ] **Step 4: Write the fixture capture script**

Create `scripts/dump-pump-fixtures.mjs`:

```js
#!/usr/bin/env node
/* Captures what litesvm needs to run the REAL pump.fun program locally:
 *   pump.so / pfee.so   — mainnet ELFs (programdata minus the 45-byte header)
 *   global.acct, fee_config.acct, gva.acct — pump's config accounts
 *   mint.acct, bonding_curve.acct, associated_bonding_curve.acct
 *                       — the state right AFTER `create` for a fixture mint,
 *                         taken from a mainnet simulateTransaction (nothing is sent)
 *   creator-keypair.json, mint-keypair.json — the fixture identities
 *   meta.txt            — captured_at, fee_recipient, buyback_fee_recipient, mint, creator
 * .acct format: owner(32) ‖ lamports u64 LE ‖ data. Output dir is gitignored.
 *
 *   RPC_URL=https://... node scripts/dump-pump-fixtures.mjs
 * SIM_PAYER (optional): pubkey to simulate `create` as; defaults to the keeper
 * (KEEPER_KEYPAIR or ~/.config/solana/id.json). Needs ≥ 0.03 SOL on mainnet
 * for the simulation to pass the rent/fee checks — never spent.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';

const require = createRequire(import.meta.url);
const sdk = require('@pump-fun/pump-sdk'); // CJS only — no ESM entry

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'litesvm-tests/fixtures');
const PUMP = sdk.PUMP_PROGRAM_ID;
const PFEE = sdk.PUMP_FEE_PROGRAM_ID;
// upgradeable-loader programdata accounts (verified on mainnet)
const PUMP_PROGRAMDATA = new PublicKey('B5MvUwXdiW1NMM6QFFD3ssPKBujD4zMohncbM73Z2BQu');
const PFEE_PROGRAMDATA = new PublicKey('75Uu23mqWBb8LM8vDppqC1mQAnCcBuLXhVaDezVMQLRw');
// SDK's CURRENT_FEE_RECIPIENTS_FOR_BUYBACK[0]; a mainnet simulate with it returned err=null
const BUYBACK = new PublicKey('5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD');
const ELF_HEADER = 45; // UpgradeableLoaderState::ProgramData header before the ELF bytes

const conn = new Connection(process.env.RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');

function loadKeeperPubkey() {
  if (process.env.SIM_PAYER) return new PublicKey(process.env.SIM_PAYER);
  const env = process.env.KEEPER_KEYPAIR;
  const raw = env
    ? (env.trim().startsWith('[') ? env : fs.readFileSync(env, 'utf8'))
    : fs.readFileSync(path.join(os.homedir(), '.config/solana/id.json'), 'utf8');
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw))).publicKey;
}

function loadOrMakeKeypair(file) {
  if (fs.existsSync(file)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, 'utf8'))));
  const kp = Keypair.generate();
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)) + '\n', { mode: 0o600 });
  return kp;
}

const acctBytes = (owner, lamports, data) => {
  const lam = Buffer.alloc(8); lam.writeBigUInt64LE(BigInt(lamports));
  return Buffer.concat([owner.toBuffer(), lam, data]);
};

async function dumpProgram(programdata, file) {
  const acc = await conn.getAccountInfo(programdata);
  if (!acc) throw new Error(`programdata ${programdata.toBase58()} not found`);
  fs.writeFileSync(path.join(OUT, file), acc.data.subarray(ELF_HEADER));
  console.log(`${file}: ${acc.data.length - ELF_HEADER} bytes`);
}

async function dumpAccount(address, file) {
  const acc = await conn.getAccountInfo(address);
  if (!acc) throw new Error(`${file}: ${address.toBase58()} not found`);
  fs.writeFileSync(path.join(OUT, file), acctBytes(acc.owner, acc.lamports, acc.data));
  console.log(`${file}: ${address.toBase58()} owner ${acc.owner.toBase58()} len ${acc.data.length}`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  await dumpProgram(PUMP_PROGRAMDATA, 'pump.so');
  await dumpProgram(PFEE_PROGRAMDATA, 'pfee.so');
  await dumpAccount(sdk.GLOBAL_PDA, 'global.acct');
  await dumpAccount(sdk.PUMP_FEE_CONFIG_PDA, 'fee_config.acct');
  await dumpAccount(sdk.GLOBAL_VOLUME_ACCUMULATOR_PDA, 'gva.acct');

  const creator = loadOrMakeKeypair(path.join(OUT, 'creator-keypair.json'));
  const mintKp = loadOrMakeKeypair(path.join(OUT, 'mint-keypair.json'));
  const mint = mintKp.publicKey;
  const payer = loadKeeperPubkey();
  const bal = await conn.getBalance(payer);
  if (bal < 30_000_000) throw new Error(`SIM_PAYER ${payer.toBase58()} holds ${bal} lamports; the create simulation needs ≥ 0.03 SOL`);

  const pump = new sdk.PumpSdk();
  const createIx = await pump.createInstruction({
    mint, name: 'FIXTURE', symbol: 'FIX', uri: 'https://example.com/fixture.json',
    creator: creator.publicKey, user: payer,
  });
  const { blockhash } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [createIx] })
    .compileToV0Message();
  const tx = new VersionedTransaction(msg);
  const bondingCurve = sdk.bondingCurvePda(mint);
  const abc = getAssociatedTokenAddressSync(mint, bondingCurve, true, TOKEN_PROGRAM_ID);
  const sim = await conn.simulateTransaction(tx, {
    sigVerify: false, replaceRecentBlockhash: true,
    accounts: { encoding: 'base64', addresses: [mint.toBase58(), bondingCurve.toBase58(), abc.toBase58()] },
  });
  if (sim.value.err) throw new Error(`create simulation failed: ${JSON.stringify(sim.value.err)}\n${(sim.value.logs || []).join('\n')}`);
  const names = ['mint.acct', 'bonding_curve.acct', 'associated_bonding_curve.acct'];
  sim.value.accounts.forEach((a, i) => {
    if (!a) throw new Error(`${names[i]}: simulation returned no account`);
    fs.writeFileSync(path.join(OUT, names[i]), acctBytes(new PublicKey(a.owner), a.lamports, Buffer.from(a.data[0], 'base64')));
    console.log(`${names[i]}: owner ${a.owner} lamports ${a.lamports} len ${Buffer.from(a.data[0], 'base64').length}`);
  });

  const global = await new sdk.OnlinePumpSdk(conn).fetchGlobal();
  const capturedAt = Math.floor(Date.now() / 1000);
  fs.writeFileSync(path.join(OUT, 'meta.txt'), [
    `captured_at=${capturedAt}`,
    `fee_recipient=${global.feeRecipient.toBase58()}`,
    `buyback_fee_recipient=${BUYBACK.toBase58()}`,
    `mint=${mint.toBase58()}`,
    `creator=${creator.publicKey.toBase58()}`,
  ].join('\n') + '\n');
  console.log(`meta.txt written · mint ${mint.toBase58()} · creator ${creator.publicKey.toBase58()} · captured_at ${capturedAt}`);
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
```

- [ ] **Step 5: Capture the fixtures**

Run: `RPC_URL=<mainnet rpc> node scripts/dump-pump-fixtures.mjs` (use the mainnet RPC from `.env`; if `SIM_PAYER` is needed, pass any mainnet pubkey holding ≥ 0.03 SOL — nothing is spent)
Expected: nine `...:` lines, `pump.so: 10485715 bytes` (10,485,760 − 45), `pfee.so: 948944 bytes`, then `meta.txt written · ...`.

Run: `ls litesvm-tests/fixtures && git status --short litesvm-tests`
Expected: 11 files listed (pump.so, pfee.so, global.acct, fee_config.acct, gva.acct, mint.acct, bonding_curve.acct, associated_bonding_curve.acct, creator-keypair.json, mint-keypair.json, meta.txt); `git status` prints nothing for `litesvm-tests` (ignored).

- [ ] **Step 6: Confirm the baseline still passes**

Run: `cd litesvm-tests && cargo test 2>&1 | grep "test result"`
Expected: every line `ok`, `0 failed` (34 tests across the suite before this plan adds any).

- [ ] **Step 7: Commit**

```bash
git add .gitignore programs/magicpad/Cargo.toml package.json pnpm-lock.yaml scripts/dump-pump-fixtures.mjs
git commit -m "pump groundwork: fixtures capture, optional-account tolerance, pump sdk

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 1: Fixture harness + spike — does the mainnet pump ELF run under litesvm?

This task gates everything after it. If the spike cannot pass, stop and report — the design assumes the real program runs locally.

**Files:**
- Create: `litesvm-tests/tests/common/pump.rs`
- Modify: `litesvm-tests/tests/common/mod.rs` (add `pub mod pump;` after the `use` block)
- Create: `litesvm-tests/tests/pump_spike.rs`

- [ ] **Step 1: Write the fixture harness**

Create `litesvm-tests/tests/common/pump.rs`:

```rust
//! pump.fun under litesvm: mainnet ELFs + accounts captured by
//! scripts/dump-pump-fixtures.mjs into ../fixtures (gitignored). Every
//! pump-dependent test calls `load_pump` and returns early on None.
use std::fs;
use std::path::{Path, PathBuf};

use litesvm::LiteSVM;
use solana_account::Account;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;

use super::{
    ata_address, ix_data, launch_pda, mint_pda, platform_pda, program_id, pump_pda, session_pda,
    system_id, token_program_id, ata_program_id, warp_to, LAMPORTS_PER_SOL,
};

pub fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures")
}

// ---- pump.fun ids and PDAs (seeds verified against mainnet in pump_spike.rs) ----
pub fn pump_id() -> Address {
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P".parse().unwrap()
}
pub fn pfee_id() -> Address {
    "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ".parse().unwrap()
}
pub fn global_pda() -> Address {
    Address::find_program_address(&[b"global"], &pump_id()).0
}
pub fn event_authority() -> Address {
    Address::find_program_address(&[b"__event_authority"], &pump_id()).0
}
pub fn gva_pda() -> Address {
    Address::find_program_address(&[b"global_volume_accumulator"], &pump_id()).0
}
pub fn fee_config_pda() -> Address {
    Address::find_program_address(&[b"fee_config", pump_id().as_ref()], &pfee_id()).0
}
pub fn bonding_curve_pda(mint: &Address) -> Address {
    Address::find_program_address(&[b"bonding-curve", mint.as_ref()], &pump_id()).0
}
pub fn bonding_curve_v2_pda(mint: &Address) -> Address {
    Address::find_program_address(&[b"bonding-curve-v2", mint.as_ref()], &pump_id()).0
}
pub fn creator_vault_pda(creator: &Address) -> Address {
    Address::find_program_address(&[b"creator-vault", creator.as_ref()], &pump_id()).0
}
pub fn uva_pda(user: &Address) -> Address {
    Address::find_program_address(&[b"user_volume_accumulator", user.as_ref()], &pump_id()).0
}

// ---- our program's pump-side PDAs ----
pub fn pump_vault_pda(launch_id: u64, trader: &Address) -> Address {
    Address::find_program_address(
        &[b"pumpvault", &launch_id.to_le_bytes(), trader.as_ref()],
        &program_id(),
    )
    .0
}
pub fn pump_launch_vault_pda(launch_id: u64) -> Address {
    Address::find_program_address(&[b"pumpvault", &launch_id.to_le_bytes()], &program_id()).0
}

pub struct PumpFixtures {
    pub captured_at: i64,
    pub fee_recipient: Address,
    pub buyback: Address,
    pub mint: Address,
    pub creator: Keypair,
    pub bonding_curve: Address,
    pub associated_bonding_curve: Address,
}

impl PumpFixtures {
    /// a second handle on the creator keypair (Keypair is not Clone)
    pub fn creator_keypair(&self) -> Keypair {
        Keypair::try_from(&self.creator.to_bytes()[..]).unwrap()
    }
}

/// .acct = owner(32) ‖ lamports u64 LE ‖ data
fn read_acct(path: &Path) -> Account {
    let b = fs::read(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    Account {
        lamports: u64::from_le_bytes(b[32..40].try_into().unwrap()),
        data: b[40..].to_vec(),
        owner: Address::try_from(&b[..32]).unwrap(),
        executable: false,
        rent_epoch: 0,
    }
}

/// solana-cli style JSON array of 64 bytes, parsed by hand (no serde here)
fn read_keypair(path: &Path) -> Keypair {
    let text = fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let bytes: Vec<u8> = text
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .split(',')
        .map(|s| s.trim().parse::<u8>().expect("keypair byte"))
        .collect();
    assert_eq!(bytes.len(), 64, "{}: expected 64 bytes", path.display());
    Keypair::try_from(&bytes[..]).unwrap()
}

/// Loads pump + pfee and the captured accounts into `svm`, funds the fee
/// wallets, and warps the clock to capture time. None (with a notice) when
/// the fixtures are absent — callers `return` and the test counts as passed.
pub fn load_pump(svm: &mut LiteSVM) -> Option<PumpFixtures> {
    let dir = fixtures_dir();
    let meta_path = dir.join("meta.txt");
    if !meta_path.exists() {
        eprintln!(
            "pump fixtures missing at {} — run `node scripts/dump-pump-fixtures.mjs` (mainnet RPC); skipping",
            dir.display()
        );
        return None;
    }
    let meta = fs::read_to_string(&meta_path).unwrap();
    let get = |key: &str| -> String {
        meta.lines()
            .find_map(|l| l.strip_prefix(&format!("{key}=")))
            .unwrap_or_else(|| panic!("meta.txt lacks {key}"))
            .trim()
            .to_string()
    };

    svm.add_program(pump_id(), &fs::read(dir.join("pump.so")).unwrap()).unwrap();
    svm.add_program(pfee_id(), &fs::read(dir.join("pfee.so")).unwrap()).unwrap();
    for (file, addr) in [
        ("global.acct", global_pda()),
        ("fee_config.acct", fee_config_pda()),
        ("gva.acct", gva_pda()),
    ] {
        svm.set_account(addr, read_acct(&dir.join(file))).unwrap();
    }

    let mint: Address = get("mint").parse().unwrap();
    let bonding_curve = bonding_curve_pda(&mint);
    let associated_bonding_curve = ata_address(&bonding_curve, &mint);
    svm.set_account(mint, read_acct(&dir.join("mint.acct"))).unwrap();
    svm.set_account(bonding_curve, read_acct(&dir.join("bonding_curve.acct"))).unwrap();
    svm.set_account(associated_bonding_curve, read_acct(&dir.join("associated_bonding_curve.acct")))
        .unwrap();

    let fee_recipient: Address = get("fee_recipient").parse().unwrap();
    let buyback: Address = get("buyback_fee_recipient").parse().unwrap();
    // pump transfers fees into these; they must exist rent-exempt
    svm.airdrop(&fee_recipient, LAMPORTS_PER_SOL).unwrap();
    svm.airdrop(&buyback, LAMPORTS_PER_SOL).unwrap();

    let captured_at: i64 = get("captured_at").parse().unwrap();
    warp_to(svm, captured_at);

    let creator = read_keypair(&dir.join("creator-keypair.json"));
    assert_eq!(creator.pubkey().to_string(), get("creator"), "meta.txt creator != creator-keypair.json");

    Some(PumpFixtures {
        captured_at,
        fee_recipient,
        buyback,
        mint,
        creator,
        bonding_curve,
        associated_bonding_curve,
    })
}

/// pump.fun bonding curve, raw offsets (spec: BondingCurve layout)
#[derive(Debug, Clone, Copy)]
pub struct BondingCurveView {
    pub virtual_token_reserves: u64,
    pub virtual_sol_reserves: u64,
    pub real_token_reserves: u64,
    pub real_sol_reserves: u64,
    pub token_total_supply: u64,
    pub complete: bool,
    pub creator: Address,
}

pub fn read_bonding_curve(svm: &LiteSVM, mint: &Address) -> BondingCurveView {
    let d = svm.get_account(&bonding_curve_pda(mint)).expect("bonding curve").data;
    let u = |at: usize| u64::from_le_bytes(d[at..at + 8].try_into().unwrap());
    BondingCurveView {
        virtual_token_reserves: u(8),
        virtual_sol_reserves: u(16),
        real_token_reserves: u(24),
        real_sol_reserves: u(32),
        token_total_supply: u(40),
        complete: d[48] != 0,
        creator: Address::try_from(&d[49..81]).unwrap(),
    }
}

/// SPL associated-token `CreateIdempotent` (data = [1])
pub fn create_ata_idempotent_ix(payer: &Address, owner: &Address, mint: &Address) -> Instruction {
    Instruction {
        program_id: ata_program_id(),
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(ata_address(owner, mint), false),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(system_id(), false),
            AccountMeta::new_readonly(token_program_id(), false),
        ],
        data: vec![1],
    }
}

/// The 18-account pump.fun `buy`. `user` pays and signs; tokens land in
/// `ata_owner`'s ATA (pump does not require ata_owner == user).
pub fn pump_buy_ix(
    user: &Address,
    mint: &Address,
    creator: &Address,
    ata_owner: &Address,
    amount: u64,
    max_sol_cost: u64,
    fee_recipient: &Address,
    buyback: &Address,
) -> Instruction {
    let bc = bonding_curve_pda(mint);
    let mut data = vec![102u8, 6, 61, 18, 1, 218, 235, 234];
    data.extend_from_slice(&amount.to_le_bytes());
    data.extend_from_slice(&max_sol_cost.to_le_bytes());
    data.push(1); // track_volume = Some(true)
    Instruction {
        program_id: pump_id(),
        accounts: vec![
            AccountMeta::new_readonly(global_pda(), false),           // 0
            AccountMeta::new(*fee_recipient, false),                  // 1
            AccountMeta::new_readonly(*mint, false),                  // 2
            AccountMeta::new(bc, false),                              // 3
            AccountMeta::new(ata_address(&bc, mint), false),          // 4
            AccountMeta::new(ata_address(ata_owner, mint), false),    // 5
            AccountMeta::new(*user, true),                            // 6
            AccountMeta::new_readonly(system_id(), false),            // 7
            AccountMeta::new_readonly(token_program_id(), false),     // 8
            AccountMeta::new(creator_vault_pda(creator), false),      // 9
            AccountMeta::new_readonly(event_authority(), false),      // 10
            AccountMeta::new_readonly(pump_id(), false),              // 11
            AccountMeta::new_readonly(gva_pda(), false),              // 12
            AccountMeta::new(uva_pda(user), false),                   // 13
            AccountMeta::new_readonly(fee_config_pda(), false),       // 14
            AccountMeta::new_readonly(pfee_id(), false),              // 15
            AccountMeta::new_readonly(bonding_curve_v2_pda(mint), false), // 16
            AccountMeta::new(*buyback, false),                        // 17
        ],
        data,
    }
}

/// pump.fun `close_user_volume_accumulator` — rent back to `user`
pub fn close_uva_ix(user: &Address) -> Instruction {
    Instruction {
        program_id: pump_id(),
        accounts: vec![
            AccountMeta::new(*user, true),
            AccountMeta::new(uva_pda(user), false),
            AccountMeta::new_readonly(event_authority(), false),
            AccountMeta::new_readonly(pump_id(), false),
        ],
        data: vec![249, 69, 164, 218, 150, 103, 84, 138],
    }
}

// ---- our instructions that carry the pump account set ----
pub struct PumpKeys {
    pub mint: Address,
    pub creator: Address,
    pub fee_recipient: Address,
    pub buyback: Address,
}

impl PumpKeys {
    pub fn from(px: &PumpFixtures) -> PumpKeys {
        PumpKeys {
            mint: px.mint,
            creator: px.creator.pubkey(),
            fee_recipient: px.fee_recipient,
            buyback: px.buyback,
        }
    }
}

#[derive(borsh::BorshSerialize)]
pub struct PumpAmountArgs {
    pub amount: u64,
    pub max_sol_cost: u64,
}

/// the 13 pump-side accounts shared by pump_claim and pump_graduate, in struct order
fn pump_side_metas(pk: &PumpKeys, user: &Address) -> Vec<AccountMeta> {
    let bc = bonding_curve_pda(&pk.mint);
    vec![
        AccountMeta::new_readonly(global_pda(), false),
        AccountMeta::new(pk.fee_recipient, false),
        AccountMeta::new(bc, false),
        AccountMeta::new(ata_address(&bc, &pk.mint), false),
        AccountMeta::new(creator_vault_pda(&pk.creator), false),
        AccountMeta::new_readonly(event_authority(), false),
        AccountMeta::new_readonly(pump_id(), false),
        AccountMeta::new_readonly(gva_pda(), false),
        AccountMeta::new(uva_pda(user), false),
        AccountMeta::new_readonly(fee_config_pda(), false),
        AccountMeta::new_readonly(pfee_id(), false),
        AccountMeta::new_readonly(bonding_curve_v2_pda(&pk.mint), false),
        AccountMeta::new(pk.buyback, false),
    ]
}

pub fn pump_claim_ix(
    cranker: &Address,
    trader: &Address,
    launch_id: u64,
    pk: &PumpKeys,
    amount: u64,
    max_sol_cost: u64,
) -> Instruction {
    let vault = pump_vault_pda(launch_id, trader);
    let mut accounts = vec![
        AccountMeta::new(*cranker, true),
        AccountMeta::new_readonly(*trader, false),
        AccountMeta::new(launch_pda(launch_id), false),
        AccountMeta::new(pump_pda(launch_id), false),
        AccountMeta::new(session_pda(launch_id, trader), false),
        AccountMeta::new(vault, false),
        AccountMeta::new_readonly(pk.mint, false),
        AccountMeta::new(ata_address(trader, &pk.mint), false),
    ];
    accounts.extend(pump_side_metas(pk, &vault));
    accounts.extend([
        AccountMeta::new_readonly(token_program_id(), false),
        AccountMeta::new_readonly(ata_program_id(), false),
        AccountMeta::new_readonly(system_id(), false),
    ]);
    Instruction {
        program_id: program_id(),
        accounts,
        data: ix_data("pump_claim", &PumpAmountArgs { amount, max_sol_cost }),
    }
}

pub fn pump_graduate_ix(
    admin: &Address,
    launch_id: u64,
    pk: &PumpKeys,
    amount: u64,
    max_sol_cost: u64,
) -> Instruction {
    let vault = pump_launch_vault_pda(launch_id);
    let mut accounts = vec![
        AccountMeta::new(*admin, true),
        AccountMeta::new(platform_pda(), false),
        AccountMeta::new(launch_pda(launch_id), false),
        AccountMeta::new(pump_pda(launch_id), false),
        AccountMeta::new(mint_pda(launch_id), false),
        AccountMeta::new(vault, false),
        AccountMeta::new(ata_address(&vault, &pk.mint), false),
        AccountMeta::new(pk.mint, false),
    ];
    accounts.extend(pump_side_metas(pk, &vault));
    accounts.extend([
        AccountMeta::new_readonly(token_program_id(), false),
        AccountMeta::new_readonly(ata_program_id(), false),
        AccountMeta::new_readonly(system_id(), false),
    ]);
    Instruction {
        program_id: program_id(),
        accounts,
        data: ix_data("pump_graduate", &PumpAmountArgs { amount, max_sol_cost }),
    }
}
```

`pump_pda` does not exist in `common/mod.rs` yet — Task 2 adds it. For this task's spike only the fixture loader and raw pump builders are exercised, but the module must compile, so add the PDA helper now. In `litesvm-tests/tests/common/mod.rs`, after `pub fn pool_pda(...)` add:

```rust
pub fn pump_pda(launch_id: u64) -> Address {
    Address::find_program_address(&[b"pump", &launch_id.to_le_bytes()], &program_id()).0
}
```

and after the `use solana_transaction::Transaction;` line add:

```rust
pub mod pump;
```

- [ ] **Step 2: Write the spike test**

Create `litesvm-tests/tests/pump_spike.rs`:

```rust
//! Gate for the whole pump plan: the mainnet pump.fun ELF must execute
//! under litesvm, a plain keypair must be able to `buy` into ANOTHER
//! wallet's ATA, and close_user_volume_accumulator must refund the user.
mod common;
use common::pump::*;
use common::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

#[test]
fn pump_pdas_match_mainnet() {
    assert_eq!(global_pda().to_string(), "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf");
    assert_eq!(gva_pda().to_string(), "Hq2wp8uJ9jCPsYgNHex8RtqdvMPfVGoYwjvF1ATiwn2Y");
    assert_eq!(event_authority().to_string(), "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1");
    assert_eq!(fee_config_pda().to_string(), "8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt");
}

#[test]
fn pump_buy_lands_in_a_foreign_ata_and_uva_closes() {
    let mut svm = fresh_svm();
    let Some(px) = load_pump(&mut svm) else { return };

    let user = Keypair::new();
    let holder = Keypair::new();
    svm.airdrop(&user.pubkey(), 5 * LAMPORTS_PER_SOL).unwrap();

    let before = read_bonding_curve(&svm, &px.mint);
    assert!(!before.complete);
    assert_eq!(before.creator, px.creator.pubkey());
    let bc_lamports_before = lamports(&svm, &px.bonding_curve);

    let amount = 1_000_000_000_000u64; // 1M tokens (6 decimals)
    let max_sol_cost = 100_000_000u64; // 0.1 SOL cap — a fresh curve fills this for ~0.028
    send(
        &mut svm,
        &user,
        &[],
        &[
            create_ata_idempotent_ix(&user.pubkey(), &holder.pubkey(), &px.mint),
            pump_buy_ix(
                &user.pubkey(),
                &px.mint,
                &px.creator.pubkey(),
                &holder.pubkey(),
                amount,
                max_sol_cost,
                &px.fee_recipient,
                &px.buyback,
            ),
        ],
    )
    .unwrap();

    let holder_ata = ata_address(&holder.pubkey(), &px.mint);
    assert_eq!(token_amount(&svm, &holder_ata), amount, "exact amount in the FOREIGN ata");
    let after = read_bonding_curve(&svm, &px.mint);
    assert_eq!(after.real_token_reserves, before.real_token_reserves - amount);
    assert!(lamports(&svm, &px.bonding_curve) > bc_lamports_before, "SOL entered the curve");

    // track_volume=true opened a user_volume_accumulator; closing refunds its rent
    let uva = uva_pda(&user.pubkey());
    assert!(lamports(&svm, &uva) > 0, "uva exists after the buy");
    let user_before = lamports(&svm, &user.pubkey());
    send(&mut svm, &user, &[], &[close_uva_ix(&user.pubkey())]).unwrap();
    assert_eq!(lamports(&svm, &uva), 0, "uva closed");
    assert!(lamports(&svm, &user.pubkey()) > user_before, "rent came back (minus the tx fee)");
}
```

- [ ] **Step 3: Run the spike**

Run: `cd litesvm-tests && cargo test --test pump_spike -- --nocapture 2>&1 | tail -15`
Expected: `test pump_pdas_match_mainnet ... ok`, `test pump_buy_lands_in_a_foreign_ata_and_uva_closes ... ok`, `test result: ok. 2 passed`.

If the buy fails with a pump custom error, print the logs (`err.meta.logs` in `FailedTransactionMetadata`) and compare the 18 metas against the spec table before touching anything else. If litesvm refuses to load `pump.so`, the plan is blocked — report it.

- [ ] **Step 4: Commit**

```bash
git add litesvm-tests/tests/common/pump.rs litesvm-tests/tests/common/mod.rs litesvm-tests/tests/pump_spike.rs
git commit -m "litesvm runs the real pump.fun: fixture loader, raw buy, foreign-ata spike

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: State, constants, errors, and the pure pump CPI module

**Files:**
- Modify: `programs/magicpad/src/constants.rs` (append)
- Modify: `programs/magicpad/src/state.rs` (append)
- Modify: `programs/magicpad/src/error.rs` (append inside the enum)
- Create: `programs/magicpad/src/pump_cpi.rs`
- Modify: `programs/magicpad/src/lib.rs:4-9` (`pub mod pump_cpi;`)
- Modify: `litesvm-tests/tests/common/mod.rs` (`E_PUMP_*`, `PumpLaunchMirror`, `read_pump`)

- [ ] **Step 1: Constants**

Append to `programs/magicpad/src/constants.rs`:

```rust

// pump.fun mode: the launch freezes at 1 SOL and every holder is bought
// onto pump.fun by the program (scripts/migrate-pump.mjs cranks it).
pub const PUMP_SEED: &[u8] = b"pump"; // PumpLaunch PDA per launch — its presence IS the mode
pub const PUMP_VAULT_SEED: &[u8] = b"pumpvault"; // signing vaults: [seed, id, trader] per claim, [seed, id] for graduate
pub const PUMP_GRADUATION_LAMPORTS: u64 = 1_000_000_000; // 1 SOL
pub const PUMP_HAIRCUT_BPS: u16 = 150; // a claim buys at most 98.5% of tokens_held — pump's fee + slippage room
```

- [ ] **Step 2: State**

Append to `programs/magicpad/src/state.rs`:

```rust

// pump.fun mode marker. Created by the launch creator before the first
// trade; pump_mint is set by the admin once the CLI has created the pump
// token; claims_done counts pump_claim for every session that traded
// (mirrors sessions_opened), so pump_graduate knows nobody is left behind.
#[account]
#[derive(InitSpace)]
pub struct PumpLaunch {
    pub launch_id: u64,
    pub pump_mint: Pubkey, // Pubkey::default() until set_pump_mint
    pub claims_done: u64,
    pub bump: u8,
}
```

- [ ] **Step 3: Errors (append-only)**

In `programs/magicpad/src/error.rs` replace

```rust
    #[msg("entry is gated — the platform co-signature is missing")]
    GateRequired, // 6023
}
```

with

```rust
    #[msg("entry is gated — the platform co-signature is missing")]
    GateRequired, // 6023
    #[msg("this launch graduates on pump.fun — use pump_claim / pump_graduate")]
    PumpMode, // 6024
    #[msg("pump mint not set yet")]
    PumpMintNotSet, // 6025
    #[msg("pump mint already set")]
    PumpMintAlreadySet, // 6026
    #[msg("pump mint does not match this launch")]
    WrongPumpMint, // 6027
    #[msg("pump claims still outstanding")]
    PumpClaimsOutstanding, // 6028
    #[msg("launch pot cannot cover this pump buy")]
    PotTooSmall, // 6029
    #[msg("claim exceeds the session's share")]
    ClaimTooLarge, // 6030
    #[msg("pump account does not match its derivation")]
    BadPumpAccount, // 6031
    #[msg("pump mode must be enabled before the first trade")]
    PumpTooLate, // 6032
}
```

- [ ] **Step 4: Pure CPI module with unit tests**

Create `programs/magicpad/src/pump_cpi.rs`:

```rust
//! pump.fun instruction shapes. Pure: no accounts, no state — only bytes and
//! keys, so the layouts can be unit-tested without a VM. Verified against
//! mainnet (spec § hard facts): `buy` takes 18 accounts, the last two as
//! remaining accounts; omitting them fails with 6062 BuybackFeeRecipientMissing.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};

pub const PUMP_PROGRAM: Pubkey = pubkey!("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
pub const PUMP_FEE_PROGRAM: Pubkey = pubkey!("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");

pub const BUY_DISC: [u8; 8] = [102, 6, 61, 18, 1, 218, 235, 234];
pub const CLOSE_UVA_DISC: [u8; 8] = [249, 69, 164, 218, 150, 103, 84, 138];
pub const BONDING_CURVE_DISC: [u8; 8] = [23, 183, 248, 55, 96, 216, 172, 96];

/// BondingCurve: disc 8 · vtok@8 · vquote@16 · real_tok@24 · real_quote@32 ·
/// tts@40 · complete@48 · creator@49..81
pub const BONDING_CURVE_MIN_LEN: usize = 81;

pub fn bonding_curve(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"bonding-curve", mint.as_ref()], &PUMP_PROGRAM).0
}

/// buy(amount, max_sol_cost, track_volume = Some(true))
pub fn buy_ix_data(amount: u64, max_sol_cost: u64) -> Vec<u8> {
    let mut d = Vec::with_capacity(25);
    d.extend_from_slice(&BUY_DISC);
    d.extend_from_slice(&amount.to_le_bytes());
    d.extend_from_slice(&max_sol_cost.to_le_bytes());
    d.push(1);
    d
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BondingCurveHead {
    pub creator: Pubkey,
    pub complete: bool,
}

/// The two fields set_pump_mint checks. None on a wrong discriminator or a short account.
pub fn parse_bonding_curve(data: &[u8]) -> Option<BondingCurveHead> {
    if data.len() < BONDING_CURVE_MIN_LEN || data[..8] != BONDING_CURVE_DISC {
        return None;
    }
    Some(BondingCurveHead {
        complete: data[48] != 0,
        creator: Pubkey::try_from(&data[49..81]).ok()?,
    })
}

/// Every key pump `buy` reads, in program order. `user` signs.
pub struct BuyKeys {
    pub global: Pubkey,
    pub fee_recipient: Pubkey,
    pub mint: Pubkey,
    pub bonding_curve: Pubkey,
    pub associated_bonding_curve: Pubkey,
    pub associated_user: Pubkey,
    pub user: Pubkey,
    pub creator_vault: Pubkey,
    pub event_authority: Pubkey,
    pub global_volume_accumulator: Pubkey,
    pub user_volume_accumulator: Pubkey,
    pub fee_config: Pubkey,
    pub bonding_curve_v2: Pubkey,
    pub buyback_fee_recipient: Pubkey,
}

pub fn buy_instruction(k: &BuyKeys, amount: u64, max_sol_cost: u64) -> Instruction {
    Instruction {
        program_id: PUMP_PROGRAM,
        accounts: vec![
            AccountMeta::new_readonly(k.global, false),                     // 0
            AccountMeta::new(k.fee_recipient, false),                       // 1
            AccountMeta::new_readonly(k.mint, false),                       // 2
            AccountMeta::new(k.bonding_curve, false),                       // 3
            AccountMeta::new(k.associated_bonding_curve, false),            // 4
            AccountMeta::new(k.associated_user, false),                     // 5
            AccountMeta::new(k.user, true),                                 // 6
            AccountMeta::new_readonly(anchor_lang::system_program::ID, false), // 7
            AccountMeta::new_readonly(anchor_spl::token::ID, false),        // 8
            AccountMeta::new(k.creator_vault, false),                       // 9
            AccountMeta::new_readonly(k.event_authority, false),            // 10
            AccountMeta::new_readonly(PUMP_PROGRAM, false),                 // 11
            AccountMeta::new_readonly(k.global_volume_accumulator, false),  // 12
            AccountMeta::new(k.user_volume_accumulator, false),             // 13
            AccountMeta::new_readonly(k.fee_config, false),                 // 14
            AccountMeta::new_readonly(PUMP_FEE_PROGRAM, false),             // 15
            AccountMeta::new_readonly(k.bonding_curve_v2, false),           // 16
            AccountMeta::new(k.buyback_fee_recipient, false),               // 17
        ],
        data: buy_ix_data(amount, max_sol_cost),
    }
}

/// close_user_volume_accumulator: rent returns to `user`
pub fn close_uva_instruction(user: Pubkey, uva: Pubkey, event_authority: Pubkey) -> Instruction {
    Instruction {
        program_id: PUMP_PROGRAM,
        accounts: vec![
            AccountMeta::new(user, true),
            AccountMeta::new(uva, false),
            AccountMeta::new_readonly(event_authority, false),
            AccountMeta::new_readonly(PUMP_PROGRAM, false),
        ],
        data: CLOSE_UVA_DISC.to_vec(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buy_data_is_disc_amount_max_flag() {
        let d = buy_ix_data(7, 9);
        assert_eq!(d.len(), 25);
        assert_eq!(&d[..8], &BUY_DISC);
        assert_eq!(u64::from_le_bytes(d[8..16].try_into().unwrap()), 7);
        assert_eq!(u64::from_le_bytes(d[16..24].try_into().unwrap()), 9);
        assert_eq!(d[24], 1);
    }

    #[test]
    fn parse_bonding_curve_reads_creator_and_complete() {
        let creator = Pubkey::new_unique();
        let mut data = vec![0u8; 150];
        data[..8].copy_from_slice(&BONDING_CURVE_DISC);
        data[48] = 1;
        data[49..81].copy_from_slice(creator.as_ref());
        assert_eq!(parse_bonding_curve(&data), Some(BondingCurveHead { creator, complete: true }));
        data[48] = 0;
        assert!(!parse_bonding_curve(&data).unwrap().complete);
    }

    #[test]
    fn parse_bonding_curve_rejects_wrong_disc_and_short_data() {
        let mut data = vec![0u8; 150];
        assert!(parse_bonding_curve(&data).is_none(), "zero disc");
        data[..8].copy_from_slice(&BONDING_CURVE_DISC);
        assert!(parse_bonding_curve(&data[..80]).is_none(), "80 bytes is one short");
    }

    #[test]
    fn buy_instruction_has_18_metas_user_signs() {
        let k = BuyKeys {
            global: Pubkey::new_unique(),
            fee_recipient: Pubkey::new_unique(),
            mint: Pubkey::new_unique(),
            bonding_curve: Pubkey::new_unique(),
            associated_bonding_curve: Pubkey::new_unique(),
            associated_user: Pubkey::new_unique(),
            user: Pubkey::new_unique(),
            creator_vault: Pubkey::new_unique(),
            event_authority: Pubkey::new_unique(),
            global_volume_accumulator: Pubkey::new_unique(),
            user_volume_accumulator: Pubkey::new_unique(),
            fee_config: Pubkey::new_unique(),
            bonding_curve_v2: Pubkey::new_unique(),
            buyback_fee_recipient: Pubkey::new_unique(),
        };
        let ix = buy_instruction(&k, 1, 2);
        assert_eq!(ix.program_id, PUMP_PROGRAM);
        assert_eq!(ix.accounts.len(), 18);
        assert!(ix.accounts[6].is_signer && ix.accounts[6].is_writable);
        assert_eq!(ix.accounts[6].pubkey, k.user);
        assert_eq!(ix.accounts[11].pubkey, PUMP_PROGRAM);
        assert_eq!(ix.accounts[15].pubkey, PUMP_FEE_PROGRAM);
        assert!(ix.accounts[17].is_writable && !ix.accounts[16].is_writable);
        let signers = ix.accounts.iter().filter(|m| m.is_signer).count();
        assert_eq!(signers, 1);
        let close = close_uva_instruction(k.user, k.user_volume_accumulator, k.event_authority);
        assert_eq!(close.accounts.len(), 4);
        assert_eq!(close.data, CLOSE_UVA_DISC.to_vec());
    }
}
```

In `programs/magicpad/src/lib.rs` replace

```rust
pub mod instructions;
pub mod state;
```

with

```rust
pub mod instructions;
pub mod pump_cpi;
pub mod state;
```

- [ ] **Step 5: Run the unit tests**

Run: `cargo test --manifest-path programs/magicpad/Cargo.toml --lib 2>&1 | grep "test result"`
Expected: `test result: ok. 22 passed; 0 failed` (18 existing + 4 new).

- [ ] **Step 6: Build and mirror in the harness**

Run: `anchor build 2>&1 | tail -2`
Expected: no `error`.

In `litesvm-tests/tests/common/mod.rs` replace

```rust
pub const E_GATE_REQUIRED: u32 = 23;
```

with

```rust
pub const E_GATE_REQUIRED: u32 = 23;
pub const E_PUMP_MODE: u32 = 24;
pub const E_PUMP_MINT_NOT_SET: u32 = 25;
pub const E_PUMP_MINT_ALREADY_SET: u32 = 26;
pub const E_WRONG_PUMP_MINT: u32 = 27;
pub const E_PUMP_CLAIMS_OUTSTANDING: u32 = 28;
pub const E_POT_TOO_SMALL: u32 = 29;
pub const E_CLAIM_TOO_LARGE: u32 = 30;
pub const E_BAD_PUMP_ACCOUNT: u32 = 31;
pub const E_PUMP_TOO_LATE: u32 = 32;
pub const PUMP_GRADUATION_LAMPORTS: u64 = 1_000_000_000; // mirrors constants.rs
pub const PUMP_HAIRCUT_BPS: u64 = 150;
```

After `pub struct TopUpMirror { ... }` add:

```rust
#[derive(borsh::BorshDeserialize, Debug)]
pub struct PumpLaunchMirror {
    pub launch_id: u64,
    pub pump_mint: [u8; 32],
    pub claims_done: u64,
    pub bump: u8,
}

pub fn read_pump(svm: &LiteSVM, id: u64) -> PumpLaunchMirror {
    read_account(svm, &pump_pda(id))
}
```

Run: `cd litesvm-tests && cargo test 2>&1 | grep "test result"`
Expected: every line `ok`, `0 failed`.

- [ ] **Step 7: Commit**

```bash
git add programs/magicpad/src/constants.rs programs/magicpad/src/state.rs programs/magicpad/src/error.rs programs/magicpad/src/pump_cpi.rs programs/magicpad/src/lib.rs litesvm-tests/tests/common/mod.rs
git commit -m "pump mode vocabulary: PumpLaunch, constants, errors 6024-6032, pure buy shapes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```


---

### Task 3: `enable_pump` — the creator opts a fresh launch into pump mode

**Files:**
- Create: `programs/magicpad/src/instructions/pump.rs`
- Modify: `programs/magicpad/src/instructions/mod.rs`
- Modify: `programs/magicpad/src/lib.rs` (inside `pub mod magicpad`, after `record_pool`)
- Modify: `litesvm-tests/tests/common/mod.rs` (`enable_pump_ix`)
- Create: `litesvm-tests/tests/pump.rs`

- [ ] **Step 1: Write the failing tests**

Add to `litesvm-tests/tests/common/mod.rs`, after `pub fn record_pool_ix(...)`:

```rust
pub fn enable_pump_ix(creator: &Address, launch_id: u64) -> Instruction {
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(*creator, true),
            AccountMeta::new_readonly(launch_pda(launch_id), false),
            AccountMeta::new(pump_pda(launch_id), false),
            AccountMeta::new_readonly(system_id(), false),
        ],
        data: ix_data("enable_pump", &launch_id),
    }
}
```

Create `litesvm-tests/tests/pump.rs`:

```rust
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
```

Check the harness: `open_trade_session_ix`, `buy_ix`, `setup_table`, `Table` fields `creator/alice/ka` exist exactly as used (`grep -n "pub fn open_trade_session_ix\|pub fn buy_ix\|pub fn setup_table\|pub ka" litesvm-tests/tests/common/mod.rs`).

- [ ] **Step 2: Run to verify they fail**

Run: `cd litesvm-tests && cargo test --test pump 2>&1 | grep -E "test result|panicked|error" | head`
Expected: the four tests fail — the program has no `enable_pump` (the tx errors with an unknown-instruction / `InstructionFallbackNotFound` custom error, not `Custom(6032)`).

- [ ] **Step 3: Implement**

Create `programs/magicpad/src/instructions/pump.rs`:

```rust
//! pump.fun mode. The PumpLaunch PDA is the switch; the four instructions
//! here are enable (creator, before any trade), set_pump_mint (admin, once
//! the CLI created the pump token), pump_claim (per session — the vault buys
//! the trader's share on pump.fun) and pump_graduate (the remainder is burnt
//! through a buy, residue to the platform, Mooner mint revoked).
use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::MagicPadError;
use crate::state::{Launch, PumpLaunch, LAUNCH_BONDING};

#[derive(Accounts)]
#[instruction(launch_id: u64)]
pub struct EnablePump<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        seeds = [LAUNCH_SEED, launch_id.to_le_bytes().as_ref()],
        bump = launch.bump,
        constraint = launch.creator == creator.key() @ MagicPadError::Unauthorized,
    )]
    pub launch: Account<'info, Launch>,
    #[account(
        init,
        payer = creator,
        space = 8 + PumpLaunch::INIT_SPACE,
        seeds = [PUMP_SEED, launch_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub pump: Account<'info, PumpLaunch>,
    pub system_program: Program<'info, System>,
}

pub fn enable_pump_handler(ctx: Context<EnablePump>, launch_id: u64) -> Result<()> {
    let l = &ctx.accounts.launch;
    // the 1 SOL line only makes sense for a market nobody has priced yet
    require!(
        l.state == LAUNCH_BONDING && l.real_sol_raised == 0 && l.tokens_sold == 0,
        MagicPadError::PumpTooLate
    );
    let p = &mut ctx.accounts.pump;
    p.launch_id = launch_id;
    p.pump_mint = Pubkey::default();
    p.claims_done = 0;
    p.bump = ctx.bumps.pump;
    Ok(())
}
```

In `programs/magicpad/src/instructions/mod.rs` add `pub mod pump;` to the module list and `pub use pump::*;` to the re-exports (keep alphabetical order with the existing entries).

In `programs/magicpad/src/lib.rs`, inside `pub mod magicpad`, after the `record_pool` function (the last one in the module) add:

```rust

    // ---- pump.fun mode ----
    pub fn enable_pump(ctx: Context<EnablePump>, launch_id: u64) -> Result<()> {
        enable_pump_handler(ctx, launch_id)
    }
```

- [ ] **Step 4: Build and run**

Run: `anchor build 2>&1 | grep -E "^error|warning: unused" ; cd litesvm-tests && cargo test --test pump 2>&1 | grep "test result"`
Expected: no build errors; `test result: ok. 4 passed; 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add programs/magicpad/src/instructions/pump.rs programs/magicpad/src/instructions/mod.rs programs/magicpad/src/lib.rs litesvm-tests/tests/common/mod.rs litesvm-tests/tests/pump.rs
git commit -m "enable_pump: the creator opts a fresh launch into pump.fun mode

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `buy` reads the marker and freezes at 1 SOL

**Files:**
- Modify: `programs/magicpad/src/instructions/trade.rs`
- Modify: `programs/magicpad/src/lib.rs:129`
- Modify: `litesvm-tests/tests/common/mod.rs` (`buy_ix_pump`)
- Modify: `litesvm-tests/tests/pump.rs`

- [ ] **Step 1: Write the failing tests**

Add to `litesvm-tests/tests/common/mod.rs`, after `pub fn buy_ix(...)`:

```rust
/// buy with the trailing optional `pump` account — the ER path for pump launches
pub fn buy_ix_pump(session_key: &Address, trader: &Address, launch_id: u64, amount_in: u64) -> Instruction {
    let mut ix = buy_ix(session_key, trader, launch_id, amount_in);
    ix.accounts.push(AccountMeta::new_readonly(pump_pda(launch_id), false));
    ix
}
```

Append to `litesvm-tests/tests/pump.rs`:

```rust

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
    // +0.2 SOL crosses 1 SOL → FROZEN (net of any fee, the line is on real_sol_raised)
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
    // the optional account resolves to None when the PDA is empty — the
    // 85 SOL line stays for ordinary launches even if a client passes it
    let mut svm = fresh_svm();
    let t = setup_table(&mut svm);
    send(
        &mut svm,
        &t.alice,
        &[],
        &[open_trade_session_ix(&t.alice.pubkey(), 0, &t.ka.pubkey(), 2 * LAMPORTS_PER_SOL)],
    )
    .unwrap();
    send(&mut svm, &t.cranker, &[&t.ka], &[buy_ix_pump(&t.ka.pubkey(), &t.alice.pubkey(), 0, 1_500_000_000)]).unwrap();
    assert_eq!(read_launch(&svm, 0).state, BONDING);
}
```

`freeze_launch_ix` exists in the harness (`grep -n "pub fn freeze_launch_ix" litesvm-tests/tests/common/mod.rs`).

- [ ] **Step 2: Run to verify they fail**

Run: `cd litesvm-tests && cargo test --test pump 2>&1 | grep -E "^test |test result"`
Expected: `pump_buy_freezes_at_one_sol` FAILS (state stays BONDING — `buy` ignores the extra account today) and `non_pump_launch_ignores_a_missing_marker` passes trivially; the third fails only if `buy` rejects the extra account (it does not — Anchor ignores surplus accounts). Whatever the split, at least one failure.

- [ ] **Step 3: Implement `BuyEr`**

In `programs/magicpad/src/instructions/trade.rs`:

Replace the import line

```rust
use crate::state::{Launch, TradeSession, LAUNCH_BONDING, LAUNCH_FROZEN};
```

with

```rust
use crate::state::{Launch, PumpLaunch, TradeSession, LAUNCH_BONDING, LAUNCH_FROZEN};
```

After the `TradeEr` struct add:

```rust

/// buy = TradeEr + an optional trailing `pump` marker. Present (and
/// non-empty) → the launch freezes at PUMP_GRADUATION_LAMPORTS. Omitted → the
/// account resolves to None (anchor-lang `allow-missing-optionals`) and the
/// 85 SOL line applies, so pre-existing clients keep working unchanged.
#[derive(Accounts)]
pub struct BuyEr<'info> {
    pub session_signer: Signer<'info>,
    #[account(
        mut,
        seeds = [SESSION_SEED, session.launch_id.to_le_bytes().as_ref(), session.trader.as_ref()],
        bump = session.bump,
        constraint = session.session_key == session_signer.key() @ MagicPadError::SessionKeyMismatch,
    )]
    pub session: Account<'info, TradeSession>,
    #[account(
        mut,
        seeds = [LAUNCH_SEED, launch.id.to_le_bytes().as_ref()],
        bump = launch.bump,
        constraint = launch.id == session.launch_id @ MagicPadError::WrongLaunch,
    )]
    pub launch: Account<'info, Launch>,
    #[account(seeds = [PUMP_SEED, launch.id.to_le_bytes().as_ref()], bump)]
    pub pump: Option<Account<'info, PumpLaunch>>,
}
```

Change the `buy_handler` signature and the crossing check. Replace

```rust
pub fn buy_handler(ctx: Context<TradeEr>, amount_in: u64) -> Result<()> {
    let l = &mut ctx.accounts.launch;
```

with

```rust
pub fn buy_handler(ctx: Context<BuyEr>, amount_in: u64) -> Result<()> {
    let line = if ctx.accounts.pump.is_some() { PUMP_GRADUATION_LAMPORTS } else { GRADUATION_LAMPORTS };
    let l = &mut ctx.accounts.launch;
```

and replace

```rust
    if l.real_sol_raised >= GRADUATION_LAMPORTS {
        l.state = LAUNCH_FROZEN;
    }
```

with

```rust
    if l.real_sol_raised >= line {
        l.state = LAUNCH_FROZEN;
    }
```

(Confirm those are the only two `GRADUATION_LAMPORTS` mentions in `buy_handler`: `grep -n GRADUATION_LAMPORTS programs/magicpad/src/instructions/trade.rs` → exactly the ones edited. `sell_handler` keeps `TradeEr`.)

In `programs/magicpad/src/lib.rs` replace

```rust
    pub fn buy(ctx: Context<TradeEr>, amount_in: u64) -> Result<()> {
```

with

```rust
    pub fn buy(ctx: Context<BuyEr>, amount_in: u64) -> Result<()> {
```

- [ ] **Step 4: Build, run pump + the full suite**

Run: `anchor build 2>&1 | grep -E "^error" ; cd litesvm-tests && cargo test 2>&1 | grep "test result"`
Expected: no build errors; every `test result` line `ok`, `0 failed` — the existing 3-account `buy_ix` callers across `rail.rs`, `fair.rs`, etc. must still pass (that is what `allow-missing-optionals` buys).

Then check the IDL: `node -e "const i=require('./target/idl/magicpad.json'); const b=i.instructions.find(x=>x.name==='buy'); console.log(b.accounts.map(a=>a.name+(a.optional?'?':'')).join(','))"`
Expected: `session_signer,session,launch,pump?`

- [ ] **Step 5: Commit**

```bash
git add programs/magicpad/src/instructions/trade.rs programs/magicpad/src/lib.rs litesvm-tests/tests/common/mod.rs litesvm-tests/tests/pump.rs
git commit -m "buy learns the 1 SOL line: optional pump marker picks the graduation threshold

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `set_pump_mint` — the admin records the pump.fun token

**Files:**
- Modify: `programs/magicpad/src/instructions/pump.rs`
- Modify: `programs/magicpad/src/lib.rs`
- Modify: `litesvm-tests/tests/common/mod.rs` (`set_pump_mint_ix`) and `litesvm-tests/tests/common/pump.rs` (`setup_pump_table`)
- Modify: `litesvm-tests/tests/pump.rs`

- [ ] **Step 1: Write the failing tests**

Add to `litesvm-tests/tests/common/mod.rs`, after `enable_pump_ix`:

```rust
pub fn set_pump_mint_ix(admin: &Address, launch_id: u64, pump_mint: &Address, bonding_curve: &Address) -> Instruction {
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(*admin, true),
            AccountMeta::new_readonly(platform_pda(), false),
            AccountMeta::new_readonly(launch_pda(launch_id), false),
            AccountMeta::new(pump_pda(launch_id), false),
            AccountMeta::new_readonly(*pump_mint, false),
            AccountMeta::new_readonly(*bonding_curve, false),
        ],
        data: ix_data_empty("set_pump_mint"),
    }
}
```

Add to `litesvm-tests/tests/common/pump.rs` (after `load_pump`):

```rust
/// setup_table, but the launch creator IS the fixture creator so pump's
/// bonding curve (creator = fixture creator) matches launch.creator.
pub fn setup_pump_table(svm: &mut LiteSVM, px: &PumpFixtures) -> super::Table {
    use super::{create_launch_ix, init_platform_ix, send, GRADUATION_LAMPORTS};
    let admin = Keypair::new();
    let creator = px.creator_keypair();
    let alice = Keypair::new();
    let bob = Keypair::new();
    let ka = Keypair::new();
    let kb = Keypair::new();
    let cranker = Keypair::new();
    for k in [&admin, &creator, &alice, &bob, &cranker] {
        svm.airdrop(&k.pubkey(), 2 * GRADUATION_LAMPORTS + 10 * LAMPORTS_PER_SOL).unwrap();
    }
    send(svm, &admin, &[], &[init_platform_ix(&admin.pubkey())]).unwrap();
    send(svm, &creator, &[], &[create_launch_ix(&creator.pubkey(), 0, "DARKPAD", "DARK")]).unwrap();
    super::Table { admin, creator, alice, bob, ka, kb, cranker }
}
```

(This mirrors `setup_table` at `common/mod.rs:640-658` exactly — same seven fields, same airdrop, same `init_platform_ix` + `create_launch_ix(…, 0, "DARKPAD", "DARK")` — with the creator swapped for the fixture keypair.)

Append to `litesvm-tests/tests/pump.rs`:

```rust

// ---- set_pump_mint --------------------------------------------------------

/// enable pump, alice (2 SOL deposit) crosses the 1 SOL line, admin freezes
/// nothing (the buy froze it), reconcile alice. Returns the table.
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
```

`E_LAUNCH_NOT_FROZEN` already exists in the harness (`litesvm-tests/tests/common/mod.rs:34`, value 1, mirroring `LaunchNotFrozen // 6001` in `error.rs:9`).

- [ ] **Step 2: Run to verify they fail**

Run: `cd litesvm-tests && cargo test --test pump set_pump_mint 2>&1 | grep -E "^test |test result"`
Expected: 4 failures (unknown instruction).

- [ ] **Step 3: Implement**

Append to `programs/magicpad/src/instructions/pump.rs` (and extend its `use` lines: add `use crate::pump_cpi;` and `Platform, LAUNCH_FROZEN, LAUNCH_RECONCILED` to the `crate::state` import):

```rust

#[derive(Accounts)]
pub struct SetPumpMint<'info> {
    pub admin: Signer<'info>,
    #[account(
        seeds = [PLATFORM_SEED],
        bump = platform.bump,
        constraint = platform.admin == admin.key() @ MagicPadError::Unauthorized,
    )]
    pub platform: Account<'info, Platform>,
    #[account(seeds = [LAUNCH_SEED, launch.id.to_le_bytes().as_ref()], bump = launch.bump)]
    pub launch: Account<'info, Launch>,
    #[account(
        mut,
        seeds = [PUMP_SEED, launch.id.to_le_bytes().as_ref()],
        bump = pump.bump,
        constraint = pump.launch_id == launch.id @ MagicPadError::WrongLaunch,
    )]
    pub pump: Account<'info, PumpLaunch>,
    /// CHECK: the pump.fun mint; only its key is recorded, the curve proves it
    pub pump_mint: UncheckedAccount<'info>,
    /// CHECK: pump's BondingCurve for pump_mint — owner + derivation checked here, creator/complete in the handler
    #[account(
        owner = pump_cpi::PUMP_PROGRAM @ MagicPadError::BadPumpAccount,
        address = pump_cpi::bonding_curve(&pump_mint.key()) @ MagicPadError::BadPumpAccount,
    )]
    pub pump_bonding_curve: UncheckedAccount<'info>,
}

pub fn set_pump_mint_handler(ctx: Context<SetPumpMint>) -> Result<()> {
    let l = &ctx.accounts.launch;
    require!(
        l.state == LAUNCH_FROZEN || l.state == LAUNCH_RECONCILED,
        MagicPadError::LaunchNotFrozen
    );
    let p = &mut ctx.accounts.pump;
    require!(p.pump_mint == Pubkey::default(), MagicPadError::PumpMintAlreadySet);
    let head = pump_cpi::parse_bonding_curve(&ctx.accounts.pump_bonding_curve.try_borrow_data()?)
        .ok_or(MagicPadError::BadPumpAccount)?;
    // the pump token must be OURS (creator = launch creator) and still on its curve
    require!(head.creator == l.creator && !head.complete, MagicPadError::BadPumpAccount);
    p.pump_mint = ctx.accounts.pump_mint.key();
    Ok(())
}
```

In `lib.rs`, after `enable_pump` add:

```rust
    pub fn set_pump_mint(ctx: Context<SetPumpMint>) -> Result<()> {
        set_pump_mint_handler(ctx)
    }
```

- [ ] **Step 4: Build and run**

Run: `anchor build 2>&1 | grep -E "^error" ; cd litesvm-tests && cargo test --test pump 2>&1 | grep "test result"`
Expected: no build errors; `test result: ok. 11 passed; 0 failed` (4 enable + 3 line + 4 set_pump_mint).

- [ ] **Step 5: Commit**

```bash
git add programs/magicpad/src/instructions/pump.rs programs/magicpad/src/lib.rs litesvm-tests/tests/common/mod.rs litesvm-tests/tests/common/pump.rs litesvm-tests/tests/pump.rs
git commit -m "set_pump_mint: the admin pins the pump.fun token to a frozen launch

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```


---

### Task 6: `pump_claim` — a session vault buys the trader's share on pump.fun

The heart of the design. Per reconciled session: the launch pot funds a vault PDA (`["pumpvault", id, trader]`), the vault signs pump `buy` as `user` with the trader's ATA as `associated_user`, the vault's volume accumulator is closed, and every lamport left in the vault flows back to the launch. No token ever sits in a program-owned account, so the holder map shows one edge: pump's bonding curve → trader.

**Files:**
- Modify: `programs/magicpad/src/instructions/pump.rs`
- Modify: `programs/magicpad/src/lib.rs`
- Modify: `litesvm-tests/tests/pump.rs`

- [ ] **Step 1: Write the failing tests**

Append to `litesvm-tests/tests/pump.rs`:

```rust

// ---- pump_claim -----------------------------------------------------------

/// alice (1.2 SOL deposit) and bob (0.5 SOL deposit). bob buys 0.1 SOL and
/// sells everything (a loser with sol_spent > 0, tokens_held == 0); alice's
/// 1.1 SOL buy crosses the line (real_sol_raised += amount_in, trade.rs:87).
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd litesvm-tests && cargo test --test pump pump_claim 2>&1 | grep -E "^test |test result"`
Expected: 5 failures (unknown instruction), or "skipping" notices + passes if fixtures are absent — in that case STOP: Task 0 Step 5 must be done on this machine first.

- [ ] **Step 3: Implement**

Append to `programs/magicpad/src/instructions/pump.rs`. Extend the imports at the top of the file to:

```rust
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::system_program::{self, Transfer};
use anchor_spl::associated_token::{self, AssociatedToken, Create};
use anchor_spl::token::{self, Burn, CloseAccount, Mint, SetAuthority, Token, TokenAccount};
use anchor_spl::token::spl_token::instruction::AuthorityType;

use crate::constants::*;
use crate::error::MagicPadError;
use crate::pump_cpi;
use crate::state::{
    Launch, Platform, PumpLaunch, TradeSession, LAUNCH_BONDING, LAUNCH_FROZEN, LAUNCH_GRADUATED,
    LAUNCH_RECONCILED,
};
```

(`Burn`, `CloseAccount`, `Mint`, `SetAuthority`, `TokenAccount`, `AuthorityType`, `LAUNCH_GRADUATED` are used by Task 7; importing them now avoids touching the header twice — cargo warns about unused imports until then, which is fine.)

Then append:

```rust

/// Rent the vault must carry on top of max_sol_cost: the trader's ATA (165
/// bytes, paid by the vault via create_idempotent), pump's
/// user_volume_accumulator (137 bytes, opened by buy, closed after, refunded
/// to the vault) and the creator vault's rent-exempt minimum for 0 bytes
/// (pump tops it up on first fee). Anything unused flows back to the launch.
fn claim_allowance() -> Result<u64> {
    let r = Rent::get()?;
    Ok(r.minimum_balance(165) + r.minimum_balance(137) + r.minimum_balance(0))
}

/// Lamports the launch may spend: everything above its own rent minimum and
/// the outstanding flip pot (which pump_graduate hands to the platform).
fn pot_available(launch: &AccountInfo, flip_pot: i64) -> Result<u64> {
    let rent_min = Rent::get()?.minimum_balance(launch.data_len());
    let pot = if flip_pot > 0 { flip_pot as u64 } else { 0 };
    Ok(launch.lamports().saturating_sub(rent_min).saturating_sub(pot))
}

/// launch → vault by direct arithmetic (the program owns the launch)
fn fund_vault(launch: &AccountInfo, vault: &AccountInfo, lamports: u64) -> Result<()> {
    **launch.try_borrow_mut_lamports()? -= lamports;
    **vault.try_borrow_mut_lamports()? += lamports;
    Ok(())
}

/// The pump-side accounts shared by pump_claim and pump_graduate, in the
/// order pump's `buy` reads them (minus mint / associated_user / user).
struct PumpSide<'a, 'info> {
    global: &'a AccountInfo<'info>,
    fee_recipient: &'a AccountInfo<'info>,
    bonding_curve: &'a AccountInfo<'info>,
    associated_bonding_curve: &'a AccountInfo<'info>,
    creator_vault: &'a AccountInfo<'info>,
    event_authority: &'a AccountInfo<'info>,
    pump_program: &'a AccountInfo<'info>,
    global_volume_accumulator: &'a AccountInfo<'info>,
    user_volume_accumulator: &'a AccountInfo<'info>,
    fee_config: &'a AccountInfo<'info>,
    fee_program: &'a AccountInfo<'info>,
    bonding_curve_v2: &'a AccountInfo<'info>,
    buyback_fee_recipient: &'a AccountInfo<'info>,
}

/// vault signs pump `buy` (tokens → `associated_user`), then closes its
/// volume accumulator so the rent returns to the vault.
#[allow(clippy::too_many_arguments)]
fn vault_buys<'info>(
    side: &PumpSide<'_, 'info>,
    mint: &AccountInfo<'info>,
    associated_user: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    vault_seeds: &[&[u8]],
    amount: u64,
    max_sol_cost: u64,
) -> Result<()> {
    let keys = pump_cpi::BuyKeys {
        global: side.global.key(),
        fee_recipient: side.fee_recipient.key(),
        mint: mint.key(),
        bonding_curve: side.bonding_curve.key(),
        associated_bonding_curve: side.associated_bonding_curve.key(),
        associated_user: associated_user.key(),
        user: vault.key(),
        creator_vault: side.creator_vault.key(),
        event_authority: side.event_authority.key(),
        global_volume_accumulator: side.global_volume_accumulator.key(),
        user_volume_accumulator: side.user_volume_accumulator.key(),
        fee_config: side.fee_config.key(),
        bonding_curve_v2: side.bonding_curve_v2.key(),
        buyback_fee_recipient: side.buyback_fee_recipient.key(),
    };
    let ix = pump_cpi::buy_instruction(&keys, amount, max_sol_cost);
    invoke_signed(
        &ix,
        &[
            side.global.clone(),
            side.fee_recipient.clone(),
            mint.clone(),
            side.bonding_curve.clone(),
            side.associated_bonding_curve.clone(),
            associated_user.clone(),
            vault.clone(),
            system_program.clone(),
            token_program.clone(),
            side.creator_vault.clone(),
            side.event_authority.clone(),
            side.pump_program.clone(),
            side.global_volume_accumulator.clone(),
            side.user_volume_accumulator.clone(),
            side.fee_config.clone(),
            side.fee_program.clone(),
            side.bonding_curve_v2.clone(),
            side.buyback_fee_recipient.clone(),
        ],
        &[vault_seeds],
    )?;
    if !side.user_volume_accumulator.data_is_empty() {
        let close = pump_cpi::close_uva_instruction(
            vault.key(),
            side.user_volume_accumulator.key(),
            side.event_authority.key(),
        );
        invoke_signed(
            &close,
            &[
                vault.clone(),
                side.user_volume_accumulator.clone(),
                side.event_authority.clone(),
                side.pump_program.clone(),
            ],
            &[vault_seeds],
        )?;
    }
    Ok(())
}

/// every lamport in the vault → launch (system transfer, vault signs)
fn sweep_vault<'info>(
    vault: &AccountInfo<'info>,
    launch: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    vault_seeds: &[&[u8]],
) -> Result<()> {
    let left = vault.lamports();
    if left > 0 {
        system_program::transfer(
            CpiContext::new_with_signer(
                system_program.key(),
                Transfer { from: vault.clone(), to: launch.clone() },
                &[vault_seeds],
            ),
            left,
        )?;
    }
    Ok(())
}

#[derive(Accounts)]
pub struct PumpClaim<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    /// CHECK: pinned to the session below
    #[account(constraint = trader.key() == session.trader @ MagicPadError::Unauthorized)]
    pub trader: UncheckedAccount<'info>,
    #[account(mut, seeds = [LAUNCH_SEED, launch.id.to_le_bytes().as_ref()], bump = launch.bump)]
    pub launch: Account<'info, Launch>,
    #[account(
        mut,
        seeds = [PUMP_SEED, launch.id.to_le_bytes().as_ref()],
        bump = pump.bump,
        constraint = pump.pump_mint != Pubkey::default() @ MagicPadError::PumpMintNotSet,
        constraint = pump.pump_mint == pump_mint.key() @ MagicPadError::WrongPumpMint,
    )]
    pub pump: Account<'info, PumpLaunch>,
    #[account(
        mut,
        seeds = [SESSION_SEED, session.launch_id.to_le_bytes().as_ref(), session.trader.as_ref()],
        bump = session.bump,
        constraint = session.launch_id == launch.id @ MagicPadError::WrongLaunch,
    )]
    pub session: Account<'info, TradeSession>,
    /// CHECK: per-session signing vault, funded from the launch for one buy and swept back
    #[account(mut, seeds = [PUMP_VAULT_SEED, launch.id.to_le_bytes().as_ref(), session.trader.as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: equals pump.pump_mint (constraint above)
    pub pump_mint: UncheckedAccount<'info>,
    /// CHECK: the trader's ATA for pump_mint — derivation checked in the handler; created by the vault
    #[account(mut)]
    pub trader_ata: UncheckedAccount<'info>,
    // ---- pump.fun's own accounts; pump validates each of them ----
    /// CHECK: pump global
    pub pump_global: UncheckedAccount<'info>,
    /// CHECK: pump fee recipient
    #[account(mut)]
    pub pump_fee_recipient: UncheckedAccount<'info>,
    /// CHECK: pump bonding curve
    #[account(mut)]
    pub pump_bonding_curve: UncheckedAccount<'info>,
    /// CHECK: bonding curve's ATA
    #[account(mut)]
    pub pump_associated_bonding_curve: UncheckedAccount<'info>,
    /// CHECK: creator vault
    #[account(mut)]
    pub pump_creator_vault: UncheckedAccount<'info>,
    /// CHECK: pump event authority
    pub pump_event_authority: UncheckedAccount<'info>,
    /// CHECK: pump program
    #[account(address = pump_cpi::PUMP_PROGRAM @ MagicPadError::BadPumpAccount)]
    pub pump_program: UncheckedAccount<'info>,
    /// CHECK: global volume accumulator
    pub pump_global_volume_accumulator: UncheckedAccount<'info>,
    /// CHECK: the VAULT's user volume accumulator (opened by buy, closed after)
    #[account(mut)]
    pub pump_user_volume_accumulator: UncheckedAccount<'info>,
    /// CHECK: fee config
    pub pump_fee_config: UncheckedAccount<'info>,
    /// CHECK: pump fee program
    #[account(address = pump_cpi::PUMP_FEE_PROGRAM @ MagicPadError::BadPumpAccount)]
    pub pump_fee_program: UncheckedAccount<'info>,
    /// CHECK: bonding curve v2
    pub pump_bonding_curve_v2: UncheckedAccount<'info>,
    /// CHECK: buyback fee recipient
    #[account(mut)]
    pub pump_buyback_fee_recipient: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

impl<'info> PumpClaim<'info> {
    fn side<'a>(&'a self) -> PumpSide<'a, 'info> {
        PumpSide {
            global: &self.pump_global,
            fee_recipient: &self.pump_fee_recipient,
            bonding_curve: &self.pump_bonding_curve,
            associated_bonding_curve: &self.pump_associated_bonding_curve,
            creator_vault: &self.pump_creator_vault,
            event_authority: &self.pump_event_authority,
            pump_program: &self.pump_program,
            global_volume_accumulator: &self.pump_global_volume_accumulator,
            user_volume_accumulator: &self.pump_user_volume_accumulator,
            fee_config: &self.pump_fee_config,
            fee_program: &self.pump_fee_program,
            bonding_curve_v2: &self.pump_bonding_curve_v2,
            buyback_fee_recipient: &self.pump_buyback_fee_recipient,
        }
    }
}

pub fn pump_claim_handler(ctx: Context<PumpClaim>, amount: u64, max_sol_cost: u64) -> Result<()> {
    let s = &ctx.accounts.session;
    require!(s.reconciled, MagicPadError::NotReconciled);
    require!(!s.tokens_claimed, MagicPadError::AlreadyClaimed);
    require_keys_eq!(
        ctx.accounts.trader_ata.key(),
        anchor_spl::associated_token::get_associated_token_address(
            &ctx.accounts.trader.key(),
            &ctx.accounts.pump_mint.key(),
        ),
        MagicPadError::BadPumpAccount
    );

    if s.tokens_held == 0 {
        // flat session: nothing to buy, just close the books
        require!(amount == 0, MagicPadError::ClaimTooLarge);
    } else {
        require!(amount > 0, MagicPadError::BadQuote);
        let ceiling = (s.tokens_held as u128 * (BPS_DENOM - PUMP_HAIRCUT_BPS) as u128
            / BPS_DENOM as u128) as u64;
        require!(amount <= ceiling, MagicPadError::ClaimTooLarge);

        let launch_ai = ctx.accounts.launch.to_account_info();
        let need = max_sol_cost.checked_add(claim_allowance()?).ok_or(MagicPadError::BadQuote)?;
        require!(
            need <= pot_available(&launch_ai, ctx.accounts.launch.flip_pot)?,
            MagicPadError::PotTooSmall
        );

        let id_bytes = ctx.accounts.launch.id.to_le_bytes();
        let trader_key = ctx.accounts.trader.key();
        let vault_bump = [ctx.bumps.vault];
        let vault_seeds: &[&[u8]] = &[PUMP_VAULT_SEED, &id_bytes, trader_key.as_ref(), &vault_bump];
        let vault = ctx.accounts.vault.to_account_info();

        fund_vault(&launch_ai, &vault, need)?;
        associated_token::create_idempotent(CpiContext::new_with_signer(
            ctx.accounts.associated_token_program.key(),
            Create {
                payer: vault.clone(),
                associated_token: ctx.accounts.trader_ata.to_account_info(),
                authority: ctx.accounts.trader.to_account_info(),
                mint: ctx.accounts.pump_mint.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
            &[vault_seeds],
        ))?;
        vault_buys(
            &ctx.accounts.side(),
            &ctx.accounts.pump_mint.to_account_info(),
            &ctx.accounts.trader_ata.to_account_info(),
            &vault,
            &ctx.accounts.system_program.to_account_info(),
            &ctx.accounts.token_program.to_account_info(),
            vault_seeds,
            amount,
            max_sol_cost,
        )?;
        sweep_vault(&vault, &launch_ai, &ctx.accounts.system_program.to_account_info(), vault_seeds)?;
    }

    let s = &mut ctx.accounts.session;
    s.tokens_claimed = true;
    // sessions_opened counts sessions that bought at least once (trade.rs);
    // mirror it so pump_graduate's completeness check lines up
    if s.sol_spent > 0 {
        ctx.accounts.pump.claims_done += 1;
    }
    Ok(())
}
```

In `lib.rs`, after `set_pump_mint` add:

```rust
    pub fn pump_claim(ctx: Context<PumpClaim>, amount: u64, max_sol_cost: u64) -> Result<()> {
        pump_claim_handler(ctx, amount, max_sol_cost)
    }
```

Notes for the implementer:
- anchor-lang 1.0.2's `CpiContext::new` / `new_with_signer` take `program_id: Pubkey` (`~/.cargo/registry/src/*/anchor-lang-1.0.2/src/context.rs:188,198`), hence `.key()` on every program account above — same as `reconcile.rs` (`CpiContext::new(ctx.accounts.system_program.key(), …)`). `&AccountInfo` has `.key()` through the prelude's `Key` trait.
- `BPS_DENOM` and `PUMP_HAIRCUT_BPS` are both `u16` in `constants.rs`; the arithmetic widens to `u128` before multiplying.
- `Rent::get()?.minimum_balance(0)` is 890,880 lamports; the vault ends up with the UVA refund + creator-vault leftover + whatever `max_sol_cost` slack pump did not take, all of which `sweep_vault` returns — that is what the conservation assertion in the test pins.
- `invoke_signed` needs every `AccountInfo` in the ix's meta order; the order above matches `pump_cpi::buy_instruction` index for index.
- Anchor evaluates the `pump` constraints (`PumpMintNotSet`, `WrongPumpMint`) before the handler runs, which is why the "needs the mint" test expects `E_PUMP_MINT_NOT_SET` on an unreconciled session.

- [ ] **Step 4: Build and run**

Run: `anchor build 2>&1 | grep -E "^error" ; cd litesvm-tests && cargo test --test pump 2>&1 | grep -E "^test |test result"`
Expected: no build errors; every pump test `ok`, `test result: ok. 16 passed; 0 failed`.

If the conservation assertion fails by exactly `minimum_balance(0)` (890,880), pump did not create the creator vault on this buy — look at `lamports(&svm, &cv)` before/after and adjust the test's `landed` sum, not the program. If `pump_claim_buys_the_share_into_the_traders_ata` fails inside the CPI, print `err.meta.logs` — pump's error text names the account it disliked.

- [ ] **Step 5: Commit**

```bash
git add programs/magicpad/src/instructions/pump.rs programs/magicpad/src/lib.rs litesvm-tests/tests/pump.rs
git commit -m "pump_claim: a session vault buys the trader's share straight into their wallet

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `pump_graduate` — burn the remainder through a buy, revoke the Mooner mint

**Files:**
- Modify: `programs/magicpad/src/instructions/pump.rs`
- Modify: `programs/magicpad/src/lib.rs`
- Modify: `litesvm-tests/tests/pump.rs`

- [ ] **Step 1: Write the failing tests**

Append to `litesvm-tests/tests/pump.rs`:

```rust

// ---- pump_graduate --------------------------------------------------------

/// claim_ready + both claims done
fn all_claimed(svm: &mut litesvm::LiteSVM, px: &PumpFixtures) -> (Table, PumpKeys) {
    let (t, pk) = claim_ready(svm, px);
    let alice = t.alice.pubkey();
    let amount = ceiling_of(read_session(svm, 0, &alice).tokens_held) / 2;
    send(svm, &t.cranker, &[], &[pump_claim_ix(&t.cranker.pubkey(), &alice, 0, &pk, amount, 700_000_000)]).unwrap();
    send(svm, &t.cranker, &[], &[pump_claim_ix(&t.cranker.pubkey(), &t.bob.pubkey(), 0, &pk, 0, 0)]).unwrap();
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
    let supply_before = mint_supply(&svm, &pk.mint);
    let platform_before = lamports(&svm, &platform_pda());
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
    assert!(lamports(&svm, &platform_pda()) > platform_before, "residue went to the platform");
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
    let res = send(&mut svm, &t.cranker, &[], &[pump_claim_ix(&t.cranker.pubkey(), &alice, 1, &pk, amount, free - allowance + 1)]);
    assert_pad_error(res, E_POT_TOO_SMALL, "a claim cannot reach into the flip pot");
    send(&mut svm, &t.cranker, &[], &[pump_claim_ix(&t.cranker.pubkey(), &alice, 1, &pk, amount, free / 2)]).unwrap();
    send(&mut svm, &t.cranker, &[], &[pump_claim_ix(&t.cranker.pubkey(), &t.bob.pubkey(), 1, &pk, 0, 0)]).unwrap();
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
    send(&mut svm, &t.cranker, &[], &[pump_claim_ix(&t.cranker.pubkey(), &alice, 0, &pk, amount, 700_000_000)]).unwrap();
    send(&mut svm, &t.cranker, &[], &[pump_claim_ix(&t.cranker.pubkey(), &t.bob.pubkey(), 0, &pk, 0, 0)]).unwrap();
    // non-admin
    let res = send(&mut svm, &t.alice, &[], &[pump_graduate_ix(&t.alice.pubkey(), 0, &pk, 0, 0)]);
    assert_pad_error(res, E_UNAUTHORIZED, "alice is not admin");
    // pot too small for the burn buy
    let res = send(&mut svm, &t.admin, &[], &[pump_graduate_ix(&t.admin.pubkey(), 0, &pk, 1_000_000_000_000, 5 * LAMPORTS_PER_SOL)]);
    assert_pad_error(res, E_POT_TOO_SMALL, "5 SOL max on a ~0.3 SOL remainder");
    send(&mut svm, &t.admin, &[], &[pump_graduate_ix(&t.admin.pubkey(), 0, &pk, 0, 0)]).unwrap();
    svm.expire_blockhash();
    let res = send(&mut svm, &t.admin, &[], &[pump_graduate_ix(&t.admin.pubkey(), 0, &pk, 0, 0)]);
    assert_pad_error(res, E_NOT_GRADUATABLE, "already graduated");
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd litesvm-tests && cargo test --test pump pump_graduate 2>&1 | grep -E "^test |test result"`
Expected: 3 failures (unknown instruction).

- [ ] **Step 3: Implement**

Append to `programs/magicpad/src/instructions/pump.rs`:

```rust

#[derive(Accounts)]
pub struct PumpGraduate<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [PLATFORM_SEED],
        bump = platform.bump,
        constraint = platform.admin == admin.key() @ MagicPadError::Unauthorized,
    )]
    pub platform: Account<'info, Platform>,
    #[account(mut, seeds = [LAUNCH_SEED, launch.id.to_le_bytes().as_ref()], bump = launch.bump)]
    pub launch: Account<'info, Launch>,
    #[account(
        mut,
        seeds = [PUMP_SEED, launch.id.to_le_bytes().as_ref()],
        bump = pump.bump,
        constraint = pump.pump_mint != Pubkey::default() @ MagicPadError::PumpMintNotSet,
        constraint = pump.pump_mint == pump_mint.key() @ MagicPadError::WrongPumpMint,
    )]
    pub pump: Account<'info, PumpLaunch>,
    /// the Mooner mint — authority revoked at the end, supply stays 0
    #[account(
        mut,
        seeds = [MINT_SEED, launch.id.to_le_bytes().as_ref()],
        bump,
        constraint = mint.key() == launch.mint @ MagicPadError::WrongLaunch,
    )]
    pub mint: Account<'info, Mint>,
    /// CHECK: the launch-level signing vault for the burn buy
    #[account(mut, seeds = [PUMP_VAULT_SEED, launch.id.to_le_bytes().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: vault's ATA for pump_mint — created, filled, burnt, closed within this ix
    #[account(mut)]
    pub vault_ata: UncheckedAccount<'info>,
    /// CHECK: equals pump.pump_mint (constraint above); mutable because burn touches supply
    #[account(mut)]
    pub pump_mint: UncheckedAccount<'info>,
    /// CHECK: pump global
    pub pump_global: UncheckedAccount<'info>,
    /// CHECK: pump fee recipient
    #[account(mut)]
    pub pump_fee_recipient: UncheckedAccount<'info>,
    /// CHECK: pump bonding curve
    #[account(mut)]
    pub pump_bonding_curve: UncheckedAccount<'info>,
    /// CHECK: bonding curve's ATA
    #[account(mut)]
    pub pump_associated_bonding_curve: UncheckedAccount<'info>,
    /// CHECK: creator vault
    #[account(mut)]
    pub pump_creator_vault: UncheckedAccount<'info>,
    /// CHECK: pump event authority
    pub pump_event_authority: UncheckedAccount<'info>,
    /// CHECK: pump program
    #[account(address = pump_cpi::PUMP_PROGRAM @ MagicPadError::BadPumpAccount)]
    pub pump_program: UncheckedAccount<'info>,
    /// CHECK: global volume accumulator
    pub pump_global_volume_accumulator: UncheckedAccount<'info>,
    /// CHECK: the VAULT's user volume accumulator
    #[account(mut)]
    pub pump_user_volume_accumulator: UncheckedAccount<'info>,
    /// CHECK: fee config
    pub pump_fee_config: UncheckedAccount<'info>,
    /// CHECK: pump fee program
    #[account(address = pump_cpi::PUMP_FEE_PROGRAM @ MagicPadError::BadPumpAccount)]
    pub pump_fee_program: UncheckedAccount<'info>,
    /// CHECK: bonding curve v2
    pub pump_bonding_curve_v2: UncheckedAccount<'info>,
    /// CHECK: buyback fee recipient
    #[account(mut)]
    pub pump_buyback_fee_recipient: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

impl<'info> PumpGraduate<'info> {
    fn side<'a>(&'a self) -> PumpSide<'a, 'info> {
        PumpSide {
            global: &self.pump_global,
            fee_recipient: &self.pump_fee_recipient,
            bonding_curve: &self.pump_bonding_curve,
            associated_bonding_curve: &self.pump_associated_bonding_curve,
            creator_vault: &self.pump_creator_vault,
            event_authority: &self.pump_event_authority,
            pump_program: &self.pump_program,
            global_volume_accumulator: &self.pump_global_volume_accumulator,
            user_volume_accumulator: &self.pump_user_volume_accumulator,
            fee_config: &self.pump_fee_config,
            fee_program: &self.pump_fee_program,
            bonding_curve_v2: &self.pump_bonding_curve_v2,
            buyback_fee_recipient: &self.pump_buyback_fee_recipient,
        }
    }
}

pub fn pump_graduate_handler(ctx: Context<PumpGraduate>, amount: u64, max_sol_cost: u64) -> Result<()> {
    let l = &ctx.accounts.launch;
    let settled = l.state == LAUNCH_RECONCILED
        || (l.state == LAUNCH_FROZEN && l.sessions_reconciled == l.sessions_opened);
    require!(settled, MagicPadError::NotGraduatable);
    require!(
        ctx.accounts.pump.claims_done == l.sessions_opened,
        MagicPadError::PumpClaimsOutstanding
    );

    let launch_ai = ctx.accounts.launch.to_account_info();
    let id_bytes = ctx.accounts.launch.id.to_le_bytes();
    let vault_bump = [ctx.bumps.vault];
    let vault_seeds: &[&[u8]] = &[PUMP_VAULT_SEED, &id_bytes, &vault_bump];
    let vault = ctx.accounts.vault.to_account_info();

    if amount > 0 {
        // the remainder becomes pump.fun liquidity and the tokens are destroyed:
        // buy into the vault's own ATA, burn, close the ATA, sweep the vault
        require_keys_eq!(
            ctx.accounts.vault_ata.key(),
            anchor_spl::associated_token::get_associated_token_address(
                &vault.key(),
                &ctx.accounts.pump_mint.key(),
            ),
            MagicPadError::BadPumpAccount
        );
        let need = max_sol_cost.checked_add(claim_allowance()?).ok_or(MagicPadError::BadQuote)?;
        // the flip pot is spendable here (it is what graduation burns) — only
        // the launch's own rent is off limits, hence flip_pot = 0
        require!(need <= pot_available(&launch_ai, 0)?, MagicPadError::PotTooSmall);
        fund_vault(&launch_ai, &vault, need)?;
        associated_token::create_idempotent(CpiContext::new_with_signer(
            ctx.accounts.associated_token_program.key(),
            Create {
                payer: vault.clone(),
                associated_token: ctx.accounts.vault_ata.to_account_info(),
                authority: vault.clone(),
                mint: ctx.accounts.pump_mint.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
            &[vault_seeds],
        ))?;
        vault_buys(
            &ctx.accounts.side(),
            &ctx.accounts.pump_mint.to_account_info(),
            &ctx.accounts.vault_ata.to_account_info(),
            &vault,
            &ctx.accounts.system_program.to_account_info(),
            &ctx.accounts.token_program.to_account_info(),
            vault_seeds,
            amount,
            max_sol_cost,
        )?;
        token::burn(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Burn {
                    mint: ctx.accounts.pump_mint.to_account_info(),
                    from: ctx.accounts.vault_ata.to_account_info(),
                    authority: vault.clone(),
                },
                &[vault_seeds],
            ),
            amount,
        )?;
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            CloseAccount {
                account: ctx.accounts.vault_ata.to_account_info(),
                destination: vault.clone(),
                authority: vault.clone(),
            },
            &[vault_seeds],
        ))?;
        sweep_vault(&vault, &launch_ai, &ctx.accounts.system_program.to_account_info(), vault_seeds)?;
    }

    // residue (incl. the flip pot — there is no Meteora seed to ship it with) → platform
    let rent_min = Rent::get()?.minimum_balance(launch_ai.data_len());
    let residue = launch_ai.lamports().saturating_sub(rent_min);
    if residue > 0 {
        let platform_ai = ctx.accounts.platform.to_account_info();
        **launch_ai.try_borrow_mut_lamports()? -= residue;
        **platform_ai.try_borrow_mut_lamports()? += residue;
    }

    // the Mooner mint never minted; lock it so it never can
    let bump = [ctx.accounts.platform.bump];
    let seeds: &[&[u8]] = &[PLATFORM_SEED, &bump];
    token::set_authority(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            SetAuthority {
                current_authority: ctx.accounts.platform.to_account_info(),
                account_or_mint: ctx.accounts.mint.to_account_info(),
            },
            &[seeds],
        ),
        AuthorityType::MintTokens,
        None,
    )?;

    ctx.accounts.launch.state = LAUNCH_GRADUATED;
    Ok(())
}
```

In `lib.rs`, after `pump_claim` add:

```rust
    pub fn pump_graduate(ctx: Context<PumpGraduate>, amount: u64, max_sol_cost: u64) -> Result<()> {
        pump_graduate_handler(ctx, amount, max_sol_cost)
    }
```

The `set_authority` call mirrors `lock_mint_handler` (`programs/magicpad/src/instructions/reconcile.rs:314-327`): the Mooner mint's authority is the platform PDA, signed with `[PLATFORM_SEED, bump]`. The flip pot is left as `graduate_handler` leaves it (never zeroed) — its lamports go to the platform inside `residue`.

- [ ] **Step 4: Build and run**

Run: `anchor build 2>&1 | grep -E "^error" ; cd litesvm-tests && cargo test --test pump 2>&1 | grep -E "^test |test result"`
Expected: no build errors; `test result: ok. 20 passed; 0 failed`.

Then the whole suite: `cd litesvm-tests && cargo test 2>&1 | grep "test result"` — every line `ok`.

- [ ] **Step 5: Commit**

```bash
git add programs/magicpad/src/instructions/pump.rs programs/magicpad/src/lib.rs litesvm-tests/tests/pump.rs
git commit -m "pump_graduate: the remainder buys and burns on pump.fun, the Mooner mint is sealed

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```


---

### Task 8: The Meteora path refuses pump launches — guard `claim_tokens` / `graduate`, teach the callers

`claim_tokens` would mint the Mooner token to a trader and `graduate` would sweep the pot to the admin — both wrong for a pump launch. The guard is an empty-PDA check: the `pump` marker must NOT exist. Every caller (harness, keeper, canary, demo, web) now passes the account.

**Files:**
- Modify: `programs/magicpad/src/instructions/reconcile.rs`
- Modify: `litesvm-tests/tests/common/mod.rs` (`claim_tokens_ix`, `graduate_ix`)
- Modify: `litesvm-tests/tests/pump.rs`
- Modify: `scripts/keeper.mjs`, `scripts/fair-canary.mjs`, `scripts/demo-trader.mjs`
- Modify: `apps/web/lib/trade-live.ts:573-588` (`claimTokens`) — the `pumpPda` import lands in Task 10; here only the account is threaded through

- [ ] **Step 1: Write the failing test**

Append to `litesvm-tests/tests/pump.rs`:

```rust

// ---- the Meteora path is closed for pump launches --------------------------

#[test]
fn claim_tokens_and_graduate_refuse_pump_launches() {
    // no fixtures: the guard fires before anything pump-related is read
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
    send(&mut svm, &t.cranker, &[&t.ka], &[buy_ix_pump(&t.ka.pubkey(), &t.alice.pubkey(), 0, 1_100_000_000)]).unwrap();
    send(&mut svm, &t.cranker, &[], &[reconcile_ix(&t.alice.pubkey(), 0)]).unwrap();
    assert_eq!(read_launch(&svm, 0).state, RECONCILED);
    let res = send(&mut svm, &t.cranker, &[], &[claim_tokens_ix(&t.cranker.pubkey(), &t.alice.pubkey(), 0)]);
    assert_pad_error(res, E_PUMP_MODE, "claim_tokens on a pump launch");
    let res = send(&mut svm, &t.admin, &[], &[graduate_ix(&t.admin.pubkey(), 0)]);
    assert_pad_error(res, E_PUMP_MODE, "graduate on a pump launch");
}
```

Update the two harness builders in `litesvm-tests/tests/common/mod.rs` — insert the marker right after the launch meta in both:

```rust
pub fn claim_tokens_ix(cranker: &Address, trader: &Address, launch_id: u64) -> Instruction {
    let mint = mint_pda(launch_id);
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(*cranker, true),
            AccountMeta::new_readonly(*trader, false),
            AccountMeta::new_readonly(platform_pda(), false),
            AccountMeta::new_readonly(launch_pda(launch_id), false),
            AccountMeta::new_readonly(pump_pda(launch_id), false), // must be empty
            AccountMeta::new(session_pda(launch_id, trader), false),
            AccountMeta::new(mint, false),
            AccountMeta::new(ata_address(trader, &mint), false),
            AccountMeta::new_readonly(token_program_id(), false),
            AccountMeta::new_readonly(ata_program_id(), false),
            AccountMeta::new_readonly(system_id(), false),
        ],
        data: ix_data_empty("claim_tokens"),
    }
}

pub fn graduate_ix(admin: &Address, launch_id: u64) -> Instruction {
    let mint = mint_pda(launch_id);
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(*admin, true),
            AccountMeta::new(platform_pda(), false),
            AccountMeta::new_readonly(config_pda(), false),
            AccountMeta::new(launch_pda(launch_id), false),
            AccountMeta::new_readonly(pump_pda(launch_id), false), // must be empty
            AccountMeta::new(mint, false),
            AccountMeta::new(ata_address(admin, &mint), false),
            AccountMeta::new_readonly(token_program_id(), false),
            AccountMeta::new_readonly(ata_program_id(), false),
            AccountMeta::new_readonly(system_id(), false),
        ],
        data: ix_data_empty("graduate"),
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd litesvm-tests && cargo test 2>&1 | grep -E "test result|FAILED|panicked" | head`
Expected: only `claim_tokens_and_graduate_refuse_pump_launches` fails (the claim goes through — there is no guard yet). Every existing claim/graduate test still passes: Anchor hands an undeclared surplus account to `remaining_accounts` and ignores it.

- [ ] **Step 3: Implement the guard**

In `programs/magicpad/src/instructions/reconcile.rs`, `ClaimTokens` — after

```rust
    #[account(seeds = [LAUNCH_SEED, launch.id.to_le_bytes().as_ref()], bump = launch.bump,
        constraint = launch.id == session.launch_id @ MagicPadError::WrongLaunch)]
    pub launch: Box<Account<'info, Launch>>,
```

add

```rust

    /// CHECK: must be EMPTY — pump.fun launches settle through pump_claim / pump_graduate
    #[account(seeds = [PUMP_SEED, launch.id.to_le_bytes().as_ref()], bump)]
    pub pump: UncheckedAccount<'info>,
```

and in `Graduate` — after

```rust
    #[account(mut, seeds = [LAUNCH_SEED, launch.id.to_le_bytes().as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, Launch>>,
```

add the same three lines. Then make the first statement of both handlers the guard:

```rust
pub fn claim_tokens_handler(ctx: Context<ClaimTokens>) -> Result<()> {
    require!(ctx.accounts.pump.data_is_empty(), MagicPadError::PumpMode);
    let s = &ctx.accounts.session;
```

```rust
pub fn graduate_handler(ctx: Context<Graduate>) -> Result<()> {
    require!(ctx.accounts.pump.data_is_empty(), MagicPadError::PumpMode);
    let (raised, flip_pot, lp_tokens) = {
```

`PUMP_SEED` arrives through the file's existing `use crate::constants::*;`.

- [ ] **Step 4: Build and run everything**

Run: `anchor build 2>&1 | grep -E "^error" ; cd litesvm-tests && cargo test 2>&1 | grep "test result"`
Expected: no build errors; every line `ok`, `0 failed` (`pump.rs` now 21 tests).

Check the IDL: `node -e "const i=require('./target/idl/magicpad.json'); for (const n of ['claim_tokens','graduate']) console.log(n, i.instructions.find(x=>x.name===n).accounts.map(a=>a.name).join(','))"`
Expected: both lists contain `pump` right after `launch`.

- [ ] **Step 5: Thread the account through the scripts**

`scripts/keeper.mjs` — after

```js
const mintPda = (id) => pda(Buffer.from('mint'), le8(id));
```

add

```js
const pumpPda = (id) => pda(Buffer.from('pump'), le8(id));
```

In `tendHome`, replace

```js
  const mint = mintPda(id);
  for (const { pubkey, s } of sessions.filter((x) => x.s.reconciled)) {
```

with

```js
  // pump.fun launches stop here: claims and graduation run through
  // scripts/migrate-pump.mjs, which the operator runs by hand
  if (await conn.getAccountInfo(pumpPda(id))) {
    log(`launch ${id}: pump launch — reconciled; scripts/migrate-pump.mjs ${id} takes it from here`);
    return;
  }

  const mint = mintPda(id);
  for (const { pubkey, s } of sessions.filter((x) => x.s.reconciled)) {
```

and add `pump: pumpPda(id),` to both `accountsPartial` blocks that follow — the `claimTokens` one:

```js
      await sendL1([await program.methods.claimTokens().accountsPartial({
        cranker: keeper.publicKey, trader: s.trader, platform: PLATFORM,
        launch, pump: pumpPda(id), session: pubkey, mint, traderAta: ata(s.trader, mint),
        tokenProgram: TOKEN_PROGRAM, associatedTokenProgram: ATA_PROGRAM,
        systemProgram: SystemProgram.programId,
      }).instruction()], `claim_tokens → ${s.trader.toBase58().slice(0, 8)}…`);
```

and the `graduate` one:

```js
    await sendL1([await program.methods.graduate().accountsPartial({
      admin: keeper.publicKey, platform: PLATFORM, config: CONFIG, launch, pump: pumpPda(id), mint,
      adminAta: ata(keeper.publicKey, mint),
      tokenProgram: TOKEN_PROGRAM, associatedTokenProgram: ATA_PROGRAM,
      systemProgram: SystemProgram.programId,
    }).instruction()], `GRADUATE launch ${id} — ${sol(l.realSolRaised)} to Meteora seed`);
```

Also update the header comment block of `keeper.mjs` — after the line `//                                   then seed Meteora + lock the mint` add:

```js
//   home + pump marker present      → reconcile only; migrate-pump.mjs (manual) finishes it
```

`scripts/fair-canary.mjs` — after `const mint = pdaOf(Buffer.from('mint'), le8(id));` (line 132) add

```js
const pump = pdaOf(Buffer.from('pump'), le8(id));
```

and add `pump,` after `launch,` in its `claimTokens` and `graduate` `accountsPartial` calls (lines 220–231):

```js
await send([await program.methods.claimTokens().accountsPartial({
  cranker: wallet.publicKey, trader: wallet.publicKey, platform: PLATFORM,
  launch, pump, session, mint, traderAta: ata(wallet.publicKey, mint),
  tokenProgram: TOKEN_PROGRAM, associatedTokenProgram: ATA_PROGRAM, systemProgram: SystemProgram.programId,
}).instruction()], '      claim_tokens');
```

```js
await send([await program.methods.graduate().accountsPartial({
  admin: wallet.publicKey, platform: PLATFORM, config: CONFIG, launch, pump, mint,
  adminAta: ata(wallet.publicKey, mint),
  tokenProgram: TOKEN_PROGRAM, associatedTokenProgram: ATA_PROGRAM, systemProgram: SystemProgram.programId,
}).instruction()], '      GRADUATE');
```

`scripts/demo-trader.mjs` — after `const mintPda = (id) => pda(Buffer.from('mint'), le8(id));` (line 56) add

```js
const pumpPda = (id) => pda(Buffer.from('pump'), le8(id));
```

and in `runPipeline`'s PHASE 6 block (line 324) add `pump: pumpPda(id),` after `launch,`:

```js
    await sendL1([await program.methods.claimTokens().accountsPartial({
      cranker: wallet.publicKey, trader: wallet.publicKey, platform: PLATFORM,
      launch, pump: pumpPda(id), session: s1, mint, traderAta,
      tokenProgram: TOKEN_PROGRAM, associatedTokenProgram: ATA_PROGRAM,
      systemProgram: SystemProgram.programId,
    }).instruction()], [wallet], 'claim_tokens (the FIRST mint of this token, ever)');
```

Check for any other `claimTokens()` / `graduate()` builders: `grep -rn "methods.claimTokens\|methods.graduate()" scripts apps/web/lib apps/web/app --include=*.mjs --include=*.ts --include=*.tsx` — the only hits must be the ones edited here plus `apps/web/lib/trade-live.ts` (next step). `scripts/mainnet-canary/` is gitignored and out of scope.

Syntax check: `node --check scripts/keeper.mjs && node --check scripts/fair-canary.mjs && node --check scripts/demo-trader.mjs && echo ok`
Expected: `ok`.

- [ ] **Step 6: Thread it through the web claim**

In `apps/web/lib/trade-live.ts`, `claimTokens` becomes:

```ts
/** Permissionless crank: mint the ledger claim into the trader's ATA.
 *  v3 (mainnet) also reads the pump marker — it must be empty; the devnet
 *  program predates it. */
export async function claimTokens(wallet: WalletLike, id: number, trader: PublicKey): Promise<string> {
  const mint = mintPda(id);
  const ix = await program.methods.claimTokens().accountsPartial({
    cranker: wallet.publicKey!,
    trader,
    platform: PLATFORM,
    launch: launchPda(id),
    ...(CLUSTER === 'mainnet' ? { pump: pumpPda(id) } : {}),
    session: sessionPda(id, trader),
    mint,
    traderAta: ata(trader, mint),
    tokenProgram: TOKEN_PROGRAM,
    associatedTokenProgram: ATA_PROGRAM,
    systemProgram: SystemProgram.programId,
  }).instruction();
  return sendWithWallet(wallet, new Transaction().add(ix));
}
```

and add `pumpPda` to the import list from `'./magicpad'` (it is exported in Task 10 Step 1 — do that step's `core.ts` + `magicpad.ts` export edits NOW if you are executing Task 8 before Task 10, otherwise the web build is red until Task 10 lands). The IDL the web uses on mainnet is `apps/web/lib/idl-v3.json`, regenerated in Task 10.

- [ ] **Step 7: Commit**

```bash
git add programs/magicpad/src/instructions/reconcile.rs litesvm-tests/tests/common/mod.rs litesvm-tests/tests/pump.rs scripts/keeper.mjs scripts/fair-canary.mjs scripts/demo-trader.mjs apps/web/lib/trade-live.ts
git commit -m "the Meteora path is closed for pump launches: claim_tokens and graduate check the marker

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: `scripts/migrate-pump.mjs` — the migration CLI

One script, three phases, idempotent on rerun: (1) create the pump.fun token with the persisted mint keypair and pin it with `set_pump_mint`; (2) `pump_claim` for every session, pro-rata to `tokens_held`, cheapest average entry first; (3) `pump_graduate` with the remainder. Dry by default — prints the plan and every number; `--confirm` sends. **The user runs `--confirm`. Never run it yourself.**

**Files:**
- Create: `scripts/migrate-pump.mjs`
- Modify: `scripts/migrate.mjs:42,59,62,124-127`

- [ ] **Step 1: Export the helpers and skip pump launches in `migrate.mjs`**

In `scripts/migrate.mjs` change the three declarations to exports:

```js
export function loadKeeper() {
```

```js
export function readRecord() {
```

```js
export function writeRecord(data) {
```

and in `migrateLaunch`, after

```js
  const l = await program.account.launch.fetch(launch);
  if (l.state !== GRADUATED) {
    log(`launch ${id}: state ${l.state} — not GRADUATED`);
    return null;
  }
```

add

```js
  // a pump.fun launch has no Meteora pool to seed — migrate-pump.mjs owns it
  if (await conn.getAccountInfo(pda(PROGRAM_ID, Buffer.from('pump'), le8(id)))) {
    log(`launch ${id}: pump.fun launch — scripts/migrate-pump.mjs owns it`);
    return null;
  }
```

Run: `node --check scripts/migrate.mjs && node -e "import('./scripts/migrate.mjs').then(m => console.log(typeof m.loadKeeper, typeof m.readRecord, typeof m.writeRecord))"`
Expected: `function function function`.

- [ ] **Step 2: Write the CLI**

Create `scripts/migrate-pump.mjs`:

```js
#!/usr/bin/env node
/* pump.fun migration for a launch that froze at the 1 SOL line.
 *
 *   node scripts/migrate-pump.mjs <launch id>            dry run: prints the whole plan, sends nothing
 *   node scripts/migrate-pump.mjs <launch id> --confirm  sends it
 *
 * Phases, each idempotent on rerun:
 *   1. create the pump.fun token from scripts/pump-mints/<id>.json (generated
 *      here and persisted BEFORE anything is sent, so the CA is known up
 *      front) with creator = launch.creator and the launch's IPFS metadata,
 *      and pin it on-chain with set_pump_mint (admin).
 *   2. pump_claim for every session that traded: the launch pot funds a
 *      per-session vault which buys the trader's pro-rata share on pump.fun
 *      straight into the trader's wallet. Flat sessions (bought, then sold
 *      everything) get a bookkeeping claim so the count completes.
 *   3. pump_graduate: the remainder becomes a burn buy, residue goes to the
 *      platform, the Mooner mint is sealed, state → GRADUATED.
 *
 * Preconditions checked here: keeper == platform admin, the launch carries
 * the pump marker, state FROZEN/RECONCILED, every session reconciled (the
 * keeper does that — rerun once it has), metadata memo present.
 *
 * env: RPC_URL (mainnet), KEEPER_KEYPAIR (path or JSON array; falls back to
 *      ~/.config/solana/id.json), CU_PRICE (µlamports, default 50000)
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import anchorPkg from '@coral-xyz/anchor';
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction,
  LAMPORTS_PER_SOL, clusterApiUrl,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { loadKeeper, readRecord, writeRecord } from './migrate.mjs';

const require = createRequire(import.meta.url);
const sdk = require('@pump-fun/pump-sdk'); // CJS only

const { AnchorProvider, Program, Wallet, BN, utils } = anchorPkg;
const bs58 = utils.bytes.bs58;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const idl = JSON.parse(fs.readFileSync(path.join(root, 'target/idl/magicpad.json'), 'utf8'));
const PROGRAM_ID = new PublicKey(idl.address);
const MINTS_DIR = path.join(root, 'scripts/pump-mints'); // gitignored
// pump's buyback fee wallet (SDK CURRENT_FEE_RECIPIENTS_FOR_BUYBACK[0]) — a
// mainnet simulate with it returned err=null; the ix fails 6062 without it
const BUYBACK = new PublicKey('5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD');
const GATEWAY = 'https://tomato-fancy-finch-338.mypinata.cloud/ipfs/'; // apps/web/lib/metadata.ts
const MEMO_RE = /^(?:\[\d+\] )?magicpad:meta:v1:([A-Za-z0-9]+)$/;
const FROZEN = 1, RECONCILED = 2, GRADUATED = 3;
const HAIRCUT_BPS = 150;     // constants.rs PUMP_HAIRCUT_BPS
const SLACK_BPS = 50;        // quote against 0.5% less than the budget; the rest is max_sol_cost headroom
const MIN_GRADUATE_BUY = 10_000_000; // below 0.01 SOL the remainder is not worth a buy
const CU_LIMIT = 400_000;    // measured ~221k CU for pump_claim
const SESSION_DISC = Buffer.from(idl.accounts.find((a) => a.name === 'TradeSession').discriminator);

const id = Number(process.argv[2]);
const confirm = process.argv.includes('--confirm');
if (!Number.isInteger(id) || id < 0) {
  console.error('usage: node scripts/migrate-pump.mjs <launch id> [--confirm]');
  process.exit(1);
}

const keeper = loadKeeper();
const conn = new Connection(process.env.RPC_URL || clusterApiUrl('mainnet-beta'), 'confirmed');
const provider = new AnchorProvider(conn, new Wallet(keeper), { commitment: 'confirmed' });
const program = new Program(idl, provider);

const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const le8 = (n) => new BN(n).toArrayLike(Buffer, 'le', 8);
const PLATFORM = pda(Buffer.from('platform'));
const launch = pda(Buffer.from('launch'), le8(id));
const moonerMint = pda(Buffer.from('mint'), le8(id));
const pump = pda(Buffer.from('pump'), le8(id));
const sessionVault = (trader) => pda(Buffer.from('pumpvault'), le8(id), trader.toBuffer());
const launchVault = pda(Buffer.from('pumpvault'), le8(id));
const ata = (owner, mint) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID);
const sol = (n) => (Number(n) / LAMPORTS_PER_SOL).toFixed(4) + '◎';
const tok = (n) => (Number(n) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 0 });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const die = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

async function send(ixs, signers, label) {
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Number(process.env.CU_PRICE || 50_000) }),
    ...ixs,
  );
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  tx.feePayer = keeper.publicKey;
  tx.recentBlockhash = blockhash;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  log(`✓ ${label} ${sig}`);
  return sig;
}

function loadOrMakeMint() {
  fs.mkdirSync(MINTS_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(MINTS_DIR, `${id}.json`);
  if (fs.existsSync(file)) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, 'utf8'))));
  }
  const kp = Keypair.generate();
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)) + '\n', { mode: 0o600 });
  log(`new mint keypair persisted at ${path.relative(root, file)}`);
  return kp;
}

/** The launch's metadata URI: newest creator-signed memo on the launch PDA,
 *  verified to resolve (same rule as apps/web/lib/metadata.ts). */
async function metadataUri(creator) {
  const sigs = await conn.getSignaturesForAddress(launch, { limit: 100 }, 'confirmed');
  for (const s of sigs.filter((x) => !x.err && x.memo && MEMO_RE.test(x.memo))) {
    const cid = MEMO_RE.exec(s.memo)[1];
    const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    if (!tx) continue;
    const msg = tx.transaction.message;
    const keys = msg.staticAccountKeys ?? msg.accountKeys;
    if (!keys[0].equals(creator)) continue;
    const uri = GATEWAY + cid;
    const ok = await fetch(uri, { signal: AbortSignal.timeout(8000) }).then((r) => r.ok).catch(() => false);
    if (ok) return uri;
    log(`memo ${cid} does not resolve at the gateway — trying an older one`);
  }
  return null;
}

/** pump-side accounts for a buy signed by `user`, in the program's field names */
function pumpSide(pumpMint, creator, user, global) {
  const bc = sdk.bondingCurvePda(pumpMint);
  return {
    pumpGlobal: sdk.GLOBAL_PDA,
    pumpFeeRecipient: global.feeRecipient,
    pumpBondingCurve: bc,
    pumpAssociatedBondingCurve: ata(bc, pumpMint),
    pumpCreatorVault: sdk.creatorVaultPda(creator),
    pumpEventAuthority: sdk.PUMP_EVENT_AUTHORITY_PDA,
    pumpProgram: sdk.PUMP_PROGRAM_ID,
    pumpGlobalVolumeAccumulator: sdk.GLOBAL_VOLUME_ACCUMULATOR_PDA,
    pumpUserVolumeAccumulator: sdk.userVolumeAccumulatorPda(user),
    pumpFeeConfig: sdk.PUMP_FEE_CONFIG_PDA,
    pumpFeeProgram: sdk.PUMP_FEE_PROGRAM_ID,
    pumpBondingCurveV2: sdk.bondingCurveV2Pda(pumpMint),
    pumpBuybackFeeRecipient: BUYBACK,
    tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  };
}

async function main() {
  log(`keeper ${keeper.publicKey.toBase58()} · ${conn.rpcEndpoint} · launch ${id} · ${confirm ? 'CONFIRM' : 'dry run'}`);

  // ---- preconditions ----
  const platform = await program.account.platform.fetch(PLATFORM);
  if (!platform.admin.equals(keeper.publicKey)) die(`keeper is not the platform admin (${platform.admin.toBase58()})`);
  let pumpAcc = await program.account.pumpLaunch.fetchNullable(pump);
  if (!pumpAcc) die(`launch ${id} has no pump marker — it graduates on Meteora (scripts/migrate.mjs)`);
  let l = await program.account.launch.fetch(launch);
  if (l.state === GRADUATED) { log(`launch ${id} is already GRADUATED — nothing to do`); return; }
  if (l.state !== FROZEN && l.state !== RECONCILED) die(`launch ${id} is still bonding (state ${l.state})`);

  const raw = await conn.getProgramAccounts(PROGRAM_ID, {
    filters: [
      { memcmp: { offset: 0, bytes: bs58.encode(SESSION_DISC) } },
      { memcmp: { offset: 8, bytes: bs58.encode(le8(id)) } },
    ],
  });
  const sessions = raw.map((r) => ({ pubkey: r.pubkey, s: program.coder.accounts.decode('tradeSession', r.account.data) }));
  const pending = sessions.filter((x) => !x.s.reconciled);
  if (pending.length) die(`${pending.length} session(s) not reconciled yet — the keeper does that; rerun afterwards`);
  const settled = l.state === RECONCILED || l.sessionsReconciled.eq(l.sessionsOpened);
  if (!settled) die(`launch not settled: ${l.sessionsReconciled}/${l.sessionsOpened} sessions reconciled`);

  const creator = l.creator;
  const mintKp = loadOrMakeMint();
  const pumpMint = mintKp.publicKey;
  console.log(`\n  CA (pump.fun mint): ${pumpMint.toBase58()}`);
  console.log(`  creator:            ${creator.toBase58()}`);
  console.log(`  name/symbol:        ${l.name} / ${l.symbol}\n`);

  const online = new sdk.OnlinePumpSdk(conn);
  const [global, feeConfig] = await Promise.all([online.fetchGlobal(), online.fetchFeeConfig()]);
  const quote = (bondingCurve, lamports) => sdk.getBuyTokenAmountFromSolAmount({
    global, feeConfig, mintSupply: bondingCurve ? global.tokenTotalSupply : null,
    bondingCurve, amount: new BN(lamports), quoteMint: NATIVE_MINT,
  });
  const liveCurve = () => online.fetchBondingCurve(pumpMint).catch(() => null);

  // ---- phase 1: create + set_pump_mint ----
  if (pumpAcc.pumpMint.equals(PublicKey.default)) {
    const curve = await liveCurve();
    const uri = await metadataUri(creator);
    if (!uri) die('no creator-signed metadata memo on the launch — retrofit metadata first (launch page → "add face")');
    log(`metadata ${uri}`);
    const ixs = [];
    const signers = [keeper];
    if (curve) {
      log(`bonding curve for ${pumpMint.toBase58()} already exists — skipping create`);
      if (!curve.creator.equals(creator)) die(`existing curve creator ${curve.creator.toBase58()} != launch creator`);
    } else {
      ixs.push(await new sdk.PumpSdk().createInstruction({
        mint: pumpMint, name: l.name, symbol: l.symbol, uri, creator, user: keeper.publicKey,
      }));
      signers.push(mintKp);
    }
    ixs.push(await program.methods.setPumpMint().accountsPartial({
      admin: keeper.publicKey, platform: PLATFORM, launch, pump,
      pumpMint, pumpBondingCurve: sdk.bondingCurvePda(pumpMint),
    }).instruction());
    if (confirm) {
      await send(ixs, signers, `create ${l.symbol} on pump.fun + set_pump_mint`);
      pumpAcc = await program.account.pumpLaunch.fetch(pump);
    } else {
      log(`[dry] would ${curve ? '' : 'create the pump token and '}set_pump_mint (${signers.length} signer(s))`);
    }
  } else {
    if (!pumpAcc.pumpMint.equals(pumpMint)) die(`on-chain pump mint ${pumpAcc.pumpMint.toBase58()} != scripts/pump-mints/${id}.json — do not mix keypairs`);
    log(`pump mint already set: ${pumpMint.toBase58()}`);
  }

  // ---- phase 2: pump_claim per session ----
  const launchAcc = await conn.getAccountInfo(launch);
  const rentMin = await conn.getMinimumBalanceForRentExemption(launchAcc.data.length);
  const flipPot = l.flipPot.isNeg() ? 0 : l.flipPot.toNumber();
  const allowance = (await conn.getMinimumBalanceForRentExemption(165))
    + (await conn.getMinimumBalanceForRentExemption(137))
    + (await conn.getMinimumBalanceForRentExemption(0));
  const potAvailable = () => conn.getBalance(launch).then((b) => b - rentMin - flipPot);

  const traded = sessions.filter((x) => x.s.solSpent.gtn(0));
  const holders = traded.filter((x) => x.s.tokensHeld.gtn(0) && !x.s.tokensClaimed)
    // cheapest average entry claims first — they paid least on Mooner, they pay least on pump
    .sort((a, b) => a.s.costBasis.mul(b.s.tokensHeld).cmp(b.s.costBasis.mul(a.s.tokensHeld)));
  const flat = traded.filter((x) => x.s.tokensHeld.isZero() && !x.s.tokensClaimed);
  const skipped = sessions.length - traded.length;
  const totalHeld = holders.reduce((acc, x) => acc.add(x.s.tokensHeld), new BN(0));
  const pot0 = await potAvailable();
  const spendable = pot0 - holders.length * allowance;
  log(`pot ${sol(pot0)} (launch − rent − flip pot ${sol(flipPot)}) · ${holders.length} holder(s), ${flat.length} flat, ${skipped} never traded · already claimed ${sessions.filter((x) => x.s.tokensClaimed).length}`);
  if (holders.length && spendable <= 0) die(`pot cannot cover ${holders.length} claim allowance(s) of ${sol(allowance)}`);

  const sigs = [];
  const previewCurve = confirm ? null : await liveCurve();
  for (const { pubkey, s } of holders) {
    const budget = Math.floor(spendable * s.tokensHeld.toNumber() / totalHeld.toNumber());
    const ceiling = s.tokensHeld.muln(10_000 - HAIRCUT_BPS).divn(10_000);
    const curve = confirm ? await liveCurve() : previewCurve; // re-quote against the live curve before every send
    const quoted = quote(curve, Math.floor(budget * (10_000 - SLACK_BPS) / 10_000));
    const amount = BN.min(ceiling, quoted);
    const share = (s.tokensHeld.toNumber() / totalHeld.toNumber() * 100).toFixed(2);
    console.log(`  ${s.trader.toBase58()}  held ${tok(s.tokensHeld)} (${share}%)  budget ${sol(budget)}  → buy ${tok(amount)} ${l.symbol}${amount.eq(ceiling) ? ' (at the 98.5% ceiling)' : ''}`);
    if (amount.isZero()) die(`budget ${sol(budget)} quotes 0 tokens for ${s.trader.toBase58()} — pot too thin to migrate`);
    if (!confirm) continue;
    const vault = sessionVault(s.trader);
    sigs.push(await send([await program.methods.pumpClaim(amount, new BN(budget)).accountsPartial({
      cranker: keeper.publicKey, trader: s.trader, launch, pump, session: pubkey, vault,
      pumpMint, traderAta: ata(s.trader, pumpMint),
      ...pumpSide(pumpMint, creator, vault, global),
    }).instruction()], [keeper], `pump_claim ${s.trader.toBase58().slice(0, 8)}… ${tok(amount)} ≤ ${sol(budget)}`));
  }
  for (const { pubkey, s } of flat) {
    console.log(`  ${s.trader.toBase58()}  flat (sold out)  → bookkeeping claim`);
    if (!confirm) continue;
    const vault = sessionVault(s.trader);
    sigs.push(await send([await program.methods.pumpClaim(new BN(0), new BN(0)).accountsPartial({
      cranker: keeper.publicKey, trader: s.trader, launch, pump, session: pubkey, vault,
      pumpMint, traderAta: ata(s.trader, pumpMint),
      ...pumpSide(pumpMint, creator, vault, global),
    }).instruction()], [keeper], `pump_claim ${s.trader.toBase58().slice(0, 8)}… (flat)`));
  }

  // ---- phase 3: pump_graduate ----
  if (confirm) pumpAcc = await program.account.pumpLaunch.fetch(pump);
  const claimsAfter = confirm ? pumpAcc.claimsDone.toNumber() : pumpAcc.claimsDone.toNumber() + holders.length + flat.length;
  if (claimsAfter !== l.sessionsOpened.toNumber()) {
    die(`claims ${claimsAfter}/${l.sessionsOpened} — a session is missing; check getProgramAccounts against the ER stragglers`);
  }
  const remaining = confirm ? await potAvailable() : spendable - holders.reduce((acc, x) => acc + Math.floor(spendable * x.s.tokensHeld.toNumber() / totalHeld.toNumber()), 0);
  let gAmount = new BN(0);
  let gMax = 0;
  if (remaining - allowance >= MIN_GRADUATE_BUY) {
    gMax = remaining - allowance;
    const curve = confirm ? await liveCurve() : previewCurve;
    gAmount = quote(curve, Math.floor(gMax * (10_000 - SLACK_BPS) / 10_000));
  }
  console.log(`  graduate: remainder ${sol(remaining)} → ${gAmount.isZero() ? 'no burn buy (below 0.01◎)' : `buy+burn ${tok(gAmount)} ${l.symbol} ≤ ${sol(gMax)}`}, residue → platform, Mooner mint sealed`);
  if (!confirm) {
    console.log(`\n[dry] nothing sent. Rerun with --confirm to execute.\n`);
    return;
  }
  sigs.push(await send([await program.methods.pumpGraduate(gAmount, new BN(gMax)).accountsPartial({
    admin: keeper.publicKey, platform: PLATFORM, launch, pump, mint: moonerMint,
    vault: launchVault, vaultAta: ata(launchVault, pumpMint), pumpMint,
    ...pumpSide(pumpMint, creator, launchVault, global),
  }).instruction()], [keeper], `pump_graduate ${tok(gAmount)} ≤ ${sol(gMax)}`));

  const record = readRecord();
  record[moonerMint.toBase58()] = {
    kind: 'pump', pumpMint: pumpMint.toBase58(), creator: creator.toBase58(),
    launchId: id, sigs, at: new Date().toISOString(),
  };
  writeRecord(record);
  l = await program.account.launch.fetch(launch);
  log(`launch ${id} state ${l.state} · https://pump.fun/coin/${pumpMint.toBase58()}`);
}

main().catch((e) => { console.error(e.logs ? e.logs.join('\n') : ''); die(e.message ?? e); });
```

- [ ] **Step 3: Static checks**

Run: `node --check scripts/migrate-pump.mjs && echo ok`
Expected: `ok`.

Run: `node scripts/migrate-pump.mjs`
Expected: the usage line and exit code 1.

Run (against whatever `RPC_URL` is in `.env`, with a launch id that is NOT a pump launch, e.g. `0`): `set -a; source .env; set +a; node scripts/migrate-pump.mjs 0`
Expected: `✗ launch 0 has no pump marker — it graduates on Meteora (scripts/migrate.mjs)` (or `keeper is not the platform admin` when the local keypair is not the admin — both prove the preconditions run before anything else). If the RPC has no deployed v3 program with `PumpLaunch` in its IDL yet, the `fetchNullable` throws — that is expected until the program upgrade in Task 11 lands; do not chase it here.

- [ ] **Step 4: Commit**

```bash
git add scripts/migrate-pump.mjs scripts/migrate.mjs
git commit -m "migrate-pump.mjs: the CLI that walks a 1 SOL launch onto pump.fun, dry by default

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```


---

### Task 10: The web learns the 1 SOL line — create checkbox, board/launch page, buy account, IDL

The program is the source of truth; the web only mirrors it: the graduation line depends on the marker, the `buy` call passes the marker when it exists, the launch page says "on pump.fun" instead of showing a pool, and the create form offers the checkbox on mainnet. The web's `GRADUATION_LAMPORTS` is env-driven (`apps/web/lib/core.ts:32-33`), the pump line is a constant — it is fixed in the program.

**Files:**
- Modify: `apps/web/lib/core.ts:31-33,74-75`
- Modify: `apps/web/lib/magicpad.ts:24-31,100,108-146,147-181`
- Modify: `apps/web/lib/trade-live.ts:20-24,472-477` (+ `readPumpLaunch`)
- Modify: `apps/web/lib/paint-trade.ts:9,17-24,54`
- Modify: `apps/web/lib/receipt.ts:20-23,111-114,276`
- Modify: `apps/web/app/create/page.tsx:21-25,66-67,82,124,208,215,225,280`
- Modify: `apps/web/app/launch/[id]/page.tsx:23-28,37-39,46-60,140-152,199,257-258,333-338,436-438,458-464,606-610,726,785`
- Modify: `apps/web/components/Board.tsx:17-20,61,106,108-114,181`
- Modify: `apps/web/components/Featured.tsx:18-20,120,122-128`
- Modify: `apps/web/app/page.tsx:8-10,77-78`
- Regenerate: `apps/web/lib/idl-v3.json`

No litesvm test covers this task; the check is `tsc --noEmit` + `next build` + a dev-server look at the create form and a launch page.

- [ ] **Step 1: IDL**

Run: `anchor build 2>&1 | grep -E "^error"; cp target/idl/magicpad.json apps/web/lib/idl-v3.json && node -e "const i=require('./apps/web/lib/idl-v3.json'); console.log(i.accounts.map(a=>a.name).join(','))"`
Expected: no errors; the list includes `PumpLaunch`. (`idl-v3.json` is what the web speaks on mainnet; the devnet IDL stays untouched.)

- [ ] **Step 2: `core.ts` — the constants and the PDA**

After

```ts
export const GRADUATION_LAMPORTS =
  Number(process.env.NEXT_PUBLIC_GRADUATION_LAMPORTS || 5 * LAMPORTS);
```

add

```ts
// pump.fun launches freeze at 1 SOL — fixed in the program (PUMP_GRADUATION_LAMPORTS)
export const PUMP_GRADUATION_LAMPORTS = 1 * LAMPORTS;
```

After

```ts
export const poolRecordPda = (mint: PublicKey) =>
  pda(Buffer.from('pool'), mint.toBuffer());
```

add

```ts
// the pump.fun marker: exists ⇔ the launch graduates on pump.fun at 1 SOL
export const pumpPda = (id: number) =>
  pda(Buffer.from('pump'), new BN(id).toArrayLike(Buffer, 'le', 8));
export const pumpUrl = (mint: string) => `https://pump.fun/coin/${mint}`;
```

- [ ] **Step 3: `magicpad.ts` — re-exports, decoder, `LaunchView.pump`, the sweep, `graduationFor`**

Re-export block: change

```ts
  mintPda, sessionPda, topupPda, poolRecordPda, buyQuote, sellQuote, erEndpointFor,
  erConnection,
} from './core';
```

to

```ts
  mintPda, sessionPda, topupPda, poolRecordPda, buyQuote, sellQuote, erEndpointFor,
  erConnection, PUMP_GRADUATION_LAMPORTS, pumpPda, pumpUrl,
} from './core';
```

After

```ts
export const decodeTopUp = (d: Buffer) => program.coder.accounts.decode('topUp', d);
```

add

```ts
export const decodePumpLaunch = (d: Buffer) => program.coder.accounts.decode('pumpLaunch', d);
```

The file's own import from `./core` (lines 14–19, distinct from the re-export block) becomes

```ts
import {
  CLUSTER, CONFIG, DLP, ENV_LAUNCH_FEE_LAMPORTS, ENV_LAUNCH_TAX_BPS, GATE, GRADUATION_LAMPORTS, LAMPORTS,
  PLATFORM, PROGRAM_ID, PUBLIC_RPC_URL, PUMP_GRADUATION_LAMPORTS, RPC_URL, TOKEN_DECIMALS, TOKEN_TOTAL_SUPPLY,
  connection, erConnection, erEndpointFor, idl, launchPda, mintPda,
  publicConnection, pumpPda,
} from './core';
```

`LaunchView` becomes

```ts
export interface LaunchView {
  id: number;
  creator: string;
  name: string;
  symbol: string;
  state: number;
  dark: boolean;          // delegated = bonding inside the ER
  createdTs: number;
  virtualSol: bigint;
  virtualTok: bigint;
  realSolRaised: number;  // lamports
  tokensSold: number;     // raw units
  sessionsOpened: number;
  mint: string;
  pump: boolean;          // graduates on pump.fun at 1 SOL
  pumpMint: string | null; // the pump.fun CA once set_pump_mint ran
}

function toView(id: number, l: any, dark: boolean, pump: { pumpMint: PublicKey } | null): LaunchView {
  return {
    id,
    creator: (l.creator as PublicKey).toBase58(),
    name: l.name as string,
    symbol: l.symbol as string,
    state: l.state as number,
    dark,
    createdTs: (l.createdTs as BN).toNumber(),
    virtualSol: BigInt((l.virtualSol as BN).toString()),
    virtualTok: BigInt((l.virtualTok as BN).toString()),
    realSolRaised: (l.realSolRaised as BN).toNumber(),
    tokensSold: (l.tokensSold as BN).toNumber(),
    sessionsOpened: (l.sessionsOpened as BN).toNumber(),
    mint: (l.mint as PublicKey).toBase58(),
    pump: pump !== null,
    pumpMint: pump && !pump.pumpMint.equals(PublicKey.default) ? pump.pumpMint.toBase58() : null,
  };
}

/** The line a launch freezes at: 1 SOL for pump.fun launches, the env line otherwise. */
export const graduationFor = (l: { pump: boolean }): number =>
  l.pump ? PUMP_GRADUATION_LAMPORTS : GRADUATION_LAMPORTS;
```

`sweepLaunches`: after the launch accounts loop

```ts
  for (let i = 0; i < keys.length; i += 100) {
    accs.push(...await conn.getMultipleAccountsInfo(keys.slice(i, i + 100)));
  }
```

add the marker sweep

```ts
  // the pump markers live on L1 and are never delegated — one more sweep
  const pumpKeys = Array.from({ length: seq }, (_, i) => pumpPda(i));
  const pumps: ({ pumpMint: PublicKey } | null)[] = [];
  for (let i = 0; i < pumpKeys.length; i += 100) {
    for (const a of await conn.getMultipleAccountsInfo(pumpKeys.slice(i, i + 100))) {
      if (!a || !a.owner.equals(PROGRAM_ID)) { pumps.push(null); continue; }
      try { pumps.push({ pumpMint: decodePumpLaunch(a.data).pumpMint as PublicKey }); } catch { pumps.push(null); }
    }
  }
```

and change the two `toView` calls:

```ts
    let view = toView(id, stale, dark, pumps[i]);
```

```ts
        if (live) view = toView(id, decodeLaunch(live.data), true, pumps[i]);
```

- [ ] **Step 4: `trade-live.ts` — the buy passes the marker, `readPumpLaunch`**

Import block: add `pumpPda` and `decodePumpLaunch`:

```ts
import {
  CLUSTER, DLP, MIN_DEPOSIT, PLATFORM, PROGRAM_ID, TOKEN_PROGRAM, TOPUP_DISCRIMINATOR,
  TOPUP_SPACE, connection, decodeLaunch, decodePumpLaunch, decodeSession, decodeTopUp, erConnection,
  erEndpointFor, fetchGateKey, launchPda, mintPda, program, pumpPda, sessionPda, topupPda,
} from './magicpad';
```

Above `buyLive` add

```ts
// whether a launch carries the pump marker — immutable once trading starts,
// so one L1 read per launch per page life is enough
const pumpFlag = new Map<number, Promise<boolean>>();
export function isPumpLaunch(id: number): Promise<boolean> {
  let p = pumpFlag.get(id);
  if (!p) {
    p = connection.getAccountInfo(pumpPda(id)).then((a) => !!a).catch(() => { pumpFlag.delete(id); return false; });
    pumpFlag.set(id, p);
  }
  return p;
}

export interface PumpView { pumpMint: string | null; claimsDone: number }

/** The pump marker's contents, or null for a Meteora launch. */
export async function readPumpLaunch(id: number): Promise<PumpView | null> {
  const a = await connection.getAccountInfo(pumpPda(id));
  if (!a) return null;
  const d = decodePumpLaunch(a.data);
  const pumpMint = d.pumpMint as PublicKey;
  return {
    pumpMint: pumpMint.equals(PublicKey.default) ? null : pumpMint.toBase58(),
    claimsDone: (d.claimsDone as BN).toNumber(),
  };
}
```

and `buyLive` becomes

```ts
export async function buyLive(wallet: WalletLike, id: number, lamports: number): Promise<string> {
  const trader = wallet.publicKey!;
  // the marker is an Option<Account> on the program side: pass it when the
  // launch has one, omit it otherwise (the devnet program has no such slot)
  const pump = CLUSTER === 'mainnet' && await isPumpLaunch(id) ? { pump: pumpPda(id) } : {};
  return sendHealing(wallet, id, async (sk) => program.methods.buy(new BN(lamports)).accountsPartial({
    sessionSigner: sk.publicKey, session: sessionPda(id, trader), launch: launchPda(id), ...pump,
  }).instruction());
}
```

`claimTokens` already carries `pump: pumpPda(id)` from Task 8 Step 6 — if that step was skipped, apply it now.

- [ ] **Step 5: `paint-trade.ts`, `receipt.ts`**

`paint-trade.ts` line 9:

```ts
import { MIN_DEPOSIT, graduationFor } from './magicpad';
```

`CurveSnap` gains the flag:

```ts
export interface CurveSnap {
  virtualSol: bigint;
  virtualTok: bigint;
  realSolRaised: number;
  tokensSold: number;
  sessionsOpened: number;
  state: number;
  pump: boolean;
}
```

and line 54:

```ts
      state: raised >= graduationFor(live) ? 1 : live.state,
```

`receipt.ts` import:

```ts
import {
  GRADUATION_LAMPORTS, LAMPORTS, PROGRAM_ID, PUMP_GRADUATION_LAMPORTS, RPC_URL, connection, erConnection,
  erEndpointFor, launchPda, mintPda, poolRecordPda, pumpPda,
} from './core';
```

In `buildReceipt`, after `const { acct: l, potLamports } = live;` add

```ts
  const pump = !!(await connection.getAccountInfo(pumpPda(id)));
```

and line 276:

```ts
      graduationTargetLamports: pump ? PUMP_GRADUATION_LAMPORTS : GRADUATION_LAMPORTS,
```

- [ ] **Step 6: `app/create/page.tsx` — the checkbox**

Import: add `pumpPda`:

```ts
import {
  CLUSTER, CONFIG, DLP, GRADUATION_LAMPORTS, LAMPORTS, MIN_DEPOSIT, PLATFORM,
  PROGRAM_ID, TOKEN_PROGRAM, VIRTUAL_SOL_INIT, VIRTUAL_TOK_INIT,
  buyQuote, fetchFees, fmtSol, fmtTok, launchPda, mintPda, program, pumpPda, sessionPda,
} from '../../lib/magicpad';
```

State, after `const [fairInfo, setFairInfo] = useState(false);`:

```ts
  const [pump, setPump] = useState(false);   // graduate on pump.fun at 1 SOL (mainnet only)
```

Line 82:

```ts
  const devLamports = !fairest && !pump && devOk && dv > 0 ? Math.round(dv * 1e9) : 0;
```

After the `createLaunch` instruction is added to `tx` — i.e. right after

```ts
        }).instruction(),
      );
```

(the closing of `new Transaction().add(…)`) add

```ts
      // the marker must exist before the first trade (enable_pump → PumpTooLate
      // afterwards), so it rides in the creation tx
      if (pump) {
        tx.add(await (program.methods as any).enablePump(new BN(id)).accountsPartial({
          creator: publicKey, launch, pump: pumpPda(id), systemProgram: SystemProgram.programId,
        }).instruction());
      }
```

Lines 208, 215, 225: every `disabled={fairest}` → `disabled={fairest || pump}`.

After the fairest field's closing `</div>` (line 280, the one right after the `{fairInfo && (…)}` block) add

```tsx
        {CLUSTER === 'mainnet' && (
          <div className="field">
            <div className="fairrow">
              <label className="faircheck">
                <input
                  type="checkbox" checked={pump}
                  onChange={(e) => { setPump(e.target.checked); if (e.target.checked) setDevBuy(''); }}
                />
                <span>graduate on pump.fun at 1◎</span>
              </label>
            </div>
            {pump && (
              <p className="note" style={{ marginTop: 6 }}>
                the dark curve stops at 1◎ instead of {fmtSol(GRADUATION_LAMPORTS, 0)}◎. the pot then
                buys every holder&apos;s share on pump.fun straight into their wallet — no pool, no claim,
                no first buy. the token page gets a pump.fun link once it&apos;s live.
              </p>
            )}
          </div>
        )}
```

- [ ] **Step 7: `app/launch/[id]/page.tsx`**

Imports:

```ts
import {
  LAMPORTS, LaunchView, MIN_DEPOSIT, STATE,
  TOKEN_DECIMALS, TOKEN_TOTAL_SUPPLY, buyQuote, fetchLaunches, fmtAge, fmtSol, fmtTok,
  graduationFor, maxCurveBuy, pumpUrl,
  launchIdFromPath, marketCapSol, sellQuote, short, solscanAccount, solscanTx,
} from '../../../lib/magicpad';
```

```ts
import {
  PositionView, PumpView, claimTokens, quickBuy, readLaunchLive, readPosition, readPumpLaunch, sellLive,
} from '../../../lib/trade-live';
```

(`GRADUATION_LAMPORTS` leaves this file — `grep -n GRADUATION_LAMPORTS 'apps/web/app/launch/[id]/page.tsx'` must return nothing after this task.)

`Live` / `toLive`:

```ts
interface Live {
  creator: string; name: string; symbol: string; state: number; dark: boolean; createdTs: number;
  virtualSol: bigint; virtualTok: bigint; realSolRaised: number; tokensSold: number;
  sessionsOpened: number; mint: string;
  pump: boolean; pumpMint: string | null;
}
const toLive = (l: any, dark: boolean, pump: PumpView | null): Live => ({
  creator: l.creator.toBase58(), name: l.name, symbol: l.symbol, state: l.state, dark,
  createdTs: l.createdTs.toNumber(),
  virtualSol: BigInt(l.virtualSol.toString()),
  virtualTok: BigInt(l.virtualTok.toString()),
  realSolRaised: l.realSolRaised.toNumber(),
  tokensSold: l.tokensSold.toNumber(),
  sessionsOpened: l.sessionsOpened.toNumber(),
  mint: l.mint.toBase58(),
  pump: pump !== null,
  pumpMint: pump?.pumpMint ?? null,
});
```

`refresh`:

```ts
    const [r, p, h, pv] = await Promise.all([
      readLaunchLive(id).catch(() => null),
      // undefined = the read FAILED this tick (ER hiccup); null = the chain
      // positively says no session. Only the latter may clear the panel.
      publicKey ? readPosition(publicKey, id).catch(() => undefined) : Promise.resolve(null),
      fetchHistory(id).catch(() => null),
      readPumpLaunch(id).catch(() => null),
    ]);
```

```ts
    if (r && caught) setLive(toLive(r.l, r.dark, pv));
```

Line 199 — the Meteora-side SPL balance read is for pool launches only:

```ts
  const publicMint = live?.state === 3 && !live.pump ? live.mint : null;
```

Lines 257–258:

```ts
  const onPool = l.state === 3 && !l.pump;
  const pct = l.state === 3 ? 100 : Math.min(100, (l.realSolRaised / graduationFor(l)) * 100);
```

Chip (333–338):

```tsx
  const chip = l.state === 0
    ? (SHOW_DARK_CHIP
      ? (l.dark ? <span className="chip dark">DARK</span> : <span className="chip">BONDING</span>)
      : null)
    : l.state === 3
      ? <span className="chip grad">{l.pump ? 'PUMP.FUN' : 'GRADUATED'}</span>
      : <span className="chip frozen">{STATE[l.state]}</span>;
```

MC label (436–438):

```tsx
                {l.state === 3
                  ? `${mc.toFixed(2)}◎ · ${l.pump ? 'live on pump.fun' : 'graduated'}`
                  : `${mc.toFixed(2)}◎ · ${pct.toFixed(1)}% to graduate`}
```

Links — after the `{onPool && poolSpot?.pool && (…)}` block (ends at line 464) add

```tsx
              {l.pump && l.pumpMint && (
                <a href={pumpUrl(l.pumpMint)} target="_blank" rel="noreferrer"
                  aria-label="pump.fun" title={l.pumpMint} className="faint">
                  pump.fun
                </a>
              )}
```

Trade card note — after the `{onPool && (…)}` block (ends at line 610) add

```tsx
            {l.pump && l.state >= 1 && (
              <p className="note" style={{ marginTop: 0 }}>
                graduates on pump.fun — the migration buys your share straight into your wallet.
                nothing to claim here{l.pumpMint ? '; trade it on pump.fun' : ''}.
              </p>
            )}
```

Claim button (726):

```tsx
            {pos && pos.reconciled && !pos.tokensClaimed && pos.tokensHeld > 0n && !l.pump && (
```

Grad label (785):

```tsx
              <span>{l.state === 3 ? (l.pump ? 'on pump.fun' : 'graduated') : `grad ${fmtSol(graduationFor(l), 0)}◎`}</span>
```

Also check every place the file passes the `Live` object where a `CurveSnap` is expected (`bumpBuy`, `bumpSell` from `paint-trade.ts`): `Live` now has `pump`, so the structural type still matches — `tsc` confirms in Step 9.

- [ ] **Step 8: `Board.tsx`, `Featured.tsx`, `app/page.tsx`**

`Board.tsx` import:

```ts
import {
  LAMPORTS, LaunchView, STATE, fetchLaunches, fmtAge, fmtSol,
  graduationFor, marketCapSol, maxCurveBuy,
} from '../lib/magicpad';
```

Line 61 (a pump launch's tokens live on pump.fun — no quick-buy after graduation):

```ts
  const tradable = (l.state === 0 && l.dark) || (l.state === 3 && !l.pump);
```

`Row` (106–114):

```tsx
  const pct = l.state === 3 ? 100 : Math.min(100, (l.realSolRaised / graduationFor(l)) * 100);
  const meta = useLaunchMeta(l.id, l.creator);
  const chip = l.state === 0
    ? (SHOW_DARK_CHIP
      ? (l.dark ? <span className="chip dark">DARK</span> : <span className="chip">BONDING</span>)
      : null)
    : l.state === 3
      ? <span className="chip grad">{l.pump ? 'PUMP.FUN' : 'GRADUATED'}</span>
      : <span className="chip frozen">{STATE[l.state]}</span>;
```

and right after `{chip}` is rendered inside `Row` (find it with `grep -n "{chip}" apps/web/components/Board.tsx`) add the line tag:

```tsx
          {l.pump && l.state < 3 && <span className="chip">1◎ → PUMP</span>}
```

Line 181:

```ts
  const stretch = bonding.filter((l) => l.realSolRaised >= 0.6 * graduationFor(l));
```

`Featured.tsx` import:

```ts
import {
  LaunchView, STATE, fmtAge, fmtSol, graduationFor, marketCapSol,
} from '../lib/magicpad';
```

Lines 120–128:

```tsx
  const pct = cur.state === 3 ? 100 : Math.min(100, (cur.realSolRaised / graduationFor(cur)) * 100);
  const desc = metas[cur.id]?.description?.trim();
  const chip = cur.state === 0
    ? (SHOW_DARK_CHIP
      ? (cur.dark ? <span className="chip dark">DARK</span> : <span className="chip">BONDING</span>)
      : null)
    : cur.state === 3
      ? <span className="chip grad">{cur.pump ? 'PUMP.FUN' : 'GRADUATED'}</span>
      : <span className="chip frozen">{STATE[cur.state]}</span>;
```

`app/page.tsx` import:

```ts
import {
  LaunchView, fetchLaunches, fmtSol, graduationFor,
} from '../lib/magicpad';
```

Lines 77–78:

```tsx
                    <i style={{ width: `${l.state === 3 ? 100 : Math.min(100, (l.realSolRaised / graduationFor(l)) * 100)}%` }} />
                    <span>{(l.state === 3 ? 100 : Math.min(100, (l.realSolRaised / graduationFor(l)) * 100)).toFixed(0)}%</span>
```

Then: `grep -rn "GRADUATION_LAMPORTS" apps/web/app apps/web/components apps/web/lib --include=*.ts --include=*.tsx`
Expected hits only in: `lib/core.ts` (definitions), `lib/magicpad.ts` (re-export + `graduationFor`), `lib/receipt.ts`, `app/create/page.tsx` (the copy still quotes the env line). Any other hit is a missed ratio — fix it with `graduationFor`.

- [ ] **Step 9: Typecheck and build**

Run: `pnpm --filter @magicpad/web exec tsc --noEmit 2>&1 | tail -20`
Expected: no output (clean). Common misses: a `CurveSnap` literal somewhere without `pump` (`grep -rn "sessionsOpened:" apps/web/lib apps/web/app --include=*.ts --include=*.tsx` lists every literal); `Live`/`LaunchView` constructed by hand in a test or a story.

Run: `pnpm --filter @magicpad/web build 2>&1 | tail -15`
Expected: `✓ Compiled successfully` (or the Next.js equivalent this version prints — read `apps/web/AGENTS.md` before touching anything Next-specific).

- [ ] **Step 10: Look at it**

Start the web dev server through the Browser pane (`.claude/launch.json` — add an entry `{"name": "web", "runtimeExecutable": "pnpm", "runtimeArgs": ["--filter", "@magicpad/web", "dev"], "port": 3000}` if none exists) and open `/create`. On devnet `CLUSTER` the checkbox is hidden; on mainnet it shows under the fairest row. Open any launch page: the grad label reads `grad <env line>◎` for a non-pump launch. Screenshot both for the commit message.

- [ ] **Step 11: Commit**

```bash
git add apps/web/lib/core.ts apps/web/lib/magicpad.ts apps/web/lib/trade-live.ts apps/web/lib/paint-trade.ts apps/web/lib/receipt.ts apps/web/app/create/page.tsx 'apps/web/app/launch/[id]/page.tsx' apps/web/components/Board.tsx apps/web/components/Featured.tsx apps/web/app/page.tsx apps/web/lib/idl-v3.json
git commit -m "the web learns the 1 SOL line: pump checkbox, marker on buy, pump.fun link instead of a pool

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Final verification and the rollout notes

Nothing new is built here; this task proves the whole branch and writes down how it ships. The program upgrade, the IDL push and the mainnet canary `--confirm` are user-run — this task prepares the exact commands and stops.

**Files:**
- Create: `docs/superpowers/plans/2026-09-09-pump-migration-rollout.md`

- [ ] **Step 1: The full suite**

Run: `anchor build 2>&1 | grep -E "^(error|warning: unused)" ; echo build-done`
Expected: `build-done` with nothing above it.

Run: `cd litesvm-tests && cargo test 2>&1 | grep -E "test result|FAILED|panicked|Running"`
Expected: every `Running` file followed by `test result: ok`; `pump.rs` reports 21 passed; `pump_spike.rs` 2 passed (or `ignored`-style skips when `litesvm-tests/fixtures/` is absent — the `load_pump` early-return prints `pump fixtures missing — run scripts/dump-pump-fixtures.mjs` and the test passes vacuously; run the dumper so the real assertions execute).

Run: `cargo test --manifest-path programs/magicpad/Cargo.toml --lib 2>&1 | grep "test result"`
Expected: `test result: ok. 22 passed`.

Run: `pnpm --filter @magicpad/web exec tsc --noEmit && pnpm --filter @magicpad/web build 2>&1 | tail -5`
Expected: clean typecheck, successful build.

Run: `node --check scripts/migrate-pump.mjs && node --check scripts/keeper.mjs && node --check scripts/migrate.mjs && node --check scripts/fair-canary.mjs && node --check scripts/demo-trader.mjs && echo scripts-ok`
Expected: `scripts-ok`.

Run: `git status --short`
Expected: empty (everything committed), and `git check-ignore litesvm-tests/fixtures scripts/pump-mints` prints both paths.

- [ ] **Step 2: Write the rollout notes**

Create `docs/superpowers/plans/2026-09-09-pump-migration-rollout.md`:

````markdown
# pump.fun migration — rollout

Everything below is user-run. Nothing here is executed by an agent.

## 1. Program upgrade (mainnet)

The v3 program gains four instructions (`enable_pump`, `set_pump_mint`,
`pump_claim`, `pump_graduate`), one account (`PumpLaunch`), an optional
trailing account on `buy`, and a required (empty) account on `claim_tokens`
and `graduate`. Existing launches are unaffected: no marker → the old line,
the old path.

```bash
anchor build && solana program deploy --program-id <PROGRAM_ID> target/deploy/magicpad.so --upgrade-authority <AUTHORITY_KEYPAIR> --url <RPC_URL>
```

```bash
anchor idl upgrade <PROGRAM_ID> --filepath target/idl/magicpad.json --provider.cluster <RPC_URL>
```

Then deploy the web (`apps/web/lib/idl-v3.json` is already the new IDL) and
restart the keeper — the old keeper would send `claim_tokens` without the
`pump` account and fail on every launch.

## 2. Canary

1. Create a launch with "graduate on pump.fun at 1◎" ticked, give it a
   face (metadata memo — `migrate-pump.mjs` refuses without one).
2. Buy past 1 SOL from two wallets, sell part from one (a flat session is
   worth covering).
3. Wait for the keeper: `launch <id>: pump launch — reconciled; scripts/migrate-pump.mjs <id> takes it from here`.
4. Dry run (prints the CA and the whole plan, sends nothing):

```bash
node scripts/migrate-pump.mjs <id>
```

5. Send it:

```bash
node scripts/migrate-pump.mjs <id> --confirm
```

6. Verify, before calling it live: `getSignaturesForAddress` on the pump mint
   shows the create + buys; `https://frontend-api-v3.pump.fun/coins/<CA>`
   returns the coin; the launch page shows `PUMP.FUN` and the link; each
   trader's wallet holds the pump token; the Mooner mint's authority is
   `None` (`spl-token display <mooner mint>`).
7. Bubblemaps: `https://app.bubblemaps.io/sol/token/<CA>` — every holder's
   tokens come from the bonding curve, no transfer edges, no hub.

## 3. If something is wrong mid-way

- `set_pump_mint` sent, claims not: rerun the CLI — it skips `create`,
  resumes claims; each claim is atomic (vault funded and swept in the same ix).
- A claim keeps failing on `PotTooSmall`: the curve moved between the quote
  and the send; rerun — the CLI re-quotes against the live curve.
- Pot too thin to claim at all (`quotes 0 tokens`): the launch stays
  RECONCILED; `freeze_launch` is not needed (it is already frozen). The
  admin can `pump_graduate` only after every claim, so the pot stays in the
  launch PDA until the numbers work — there is no drain path.
- ER cloning: the marker is never delegated; the ER validator clones
  non-delegated accounts on first use (the canary precedent).

## 4. What never changes

- `scripts/mainnet-canary/` stays gitignored; never push it.
- `scripts/pump-mints/<id>.json` is the pump token's mint secret. Back it up
  off-repo; losing it before phase 1 sends means a new CA on the next run —
  after phase 1 the mint is on-chain and the file is only needed for the
  `create` signature, which is already done.
````

- [ ] **Step 3: Commit and hand over**

```bash
git add docs/superpowers/plans/2026-09-09-pump-migration-rollout.md
git commit -m "pump migration rollout notes: upgrade, canary, recovery

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Then report to the user: the branch, the test counts from Step 1 verbatim, and the two user-run commands (program upgrade, `migrate-pump.mjs <id> --confirm`). Do not run either.
