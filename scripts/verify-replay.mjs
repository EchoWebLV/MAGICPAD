// prove the chart's replay math: replay ER trade history for a launch and
// compare end reserves against the live delegated account. exact or bust.
import { Connection, PublicKey } from '@solana/web3.js';
import { BorshCoder, BorshInstructionCoder } from '@coral-xyz/anchor';
import { readFileSync } from 'node:fs';

const id = BigInt(process.argv[2] ?? '2');
const idl = JSON.parse(readFileSync(new URL('../apps/web/lib/idl.json', import.meta.url)));
const PROGRAM_ID = new PublicKey(idl.address);
const ixCoder = new BorshInstructionCoder(idl);
const accCoder = new BorshCoder(idl);

const launch = PublicKey.findProgramAddressSync(
  [Buffer.from('launch'), new Uint8Array(new BigUint64Array([id]).buffer)], PROGRAM_ID,
)[0];

const r = await fetch('https://devnet-router.magicblock.app/getDelegationStatus', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getDelegationStatus', params: [launch.toBase58()] }),
}).then((x) => x.json());
if (!r.result?.isDelegated) { console.log('not delegated — nothing to verify'); process.exit(0); }
const er = new Connection(r.result.fqdn, 'confirmed');

// oldest-first trade list from the ER ledger
const sigs = (await er.getSignaturesForAddress(launch, { limit: 100 })).reverse();
let vs = 30_000_000_000n, vt = 1_073_000_000_000_000n; // constants.rs inits
const buyQuote = (s, t, inn) => { const k = s * t; const nvt = k / (s + inn) + 1n; return nvt >= t ? 0n : t - nvt; };
const sellQuote = (s, t, tin) => { const k = s * t; const nvs = k / (t + tin) + 1n; return nvs >= s ? 0n : s - nvs; };

for (const s of sigs) {
  if (s.err) continue;
  const tx = await er.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
  if (!tx) continue;
  const msg = tx.transaction.message;
  const keys = msg.staticAccountKeys ?? msg.accountKeys;
  for (const ix of msg.compiledInstructions ?? msg.instructions ?? []) {
    if (!keys[ix.programIdIndex]?.equals(PROGRAM_ID)) continue;
    let dec = null;
    try { dec = ixCoder.decode(Buffer.from(ix.data)); } catch { continue; }
    if (dec?.name === 'buy') {
      const inn = BigInt(dec.data.amount_in.toString());
      const out = buyQuote(vs, vt, inn); vs += inn; vt -= out;
      console.log(`replayed BUY  ${inn} in  -> ${out} tokens out`);
    } else if (dec?.name === 'sell') {
      const tin = BigInt(dec.data.tokens_in.toString());
      const out = sellQuote(vs, vt, tin); vs -= out; vt += tin;
      console.log(`replayed SELL ${tin} in -> ${out} lamports out`);
    }
  }
}

const live = accCoder.accounts.decode('Launch', (await er.getAccountInfo(launch, 'confirmed')).data);
const lvs = BigInt(live.virtual_sol?.toString?.() ?? live.virtualSol.toString());
const lvt = BigInt(live.virtual_tok?.toString?.() ?? live.virtualTok.toString());
console.log(`replay end: vs=${vs} vt=${vt}`);
console.log(`live  now : vs=${lvs} vt=${lvt}`);
console.log(vs === lvs && vt === lvt ? 'EXACT MATCH — replay is truth' : 'MISMATCH — replay math diverges');
