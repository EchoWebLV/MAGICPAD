// probe: can we reconstruct full trade history from L1 + ER ledgers?
import { Connection, PublicKey } from '@solana/web3.js';
import { BorshInstructionCoder } from '@coral-xyz/anchor';
import { readFileSync } from 'node:fs';

const idl = JSON.parse(readFileSync(new URL('../apps/web/lib/idl.json', import.meta.url)));
const PROGRAM_ID = new PublicKey(idl.address);
const ROUTER = 'https://devnet-router.magicblock.app';
const l1 = new Connection('https://api.devnet.solana.com', 'confirmed');
const coder = new BorshInstructionCoder(idl);

const launch = PublicKey.findProgramAddressSync(
  [Buffer.from('launch'), new Uint8Array(new BigUint64Array([2n]).buffer)], PROGRAM_ID,
)[0];
console.log('launch 2 pda:', launch.toBase58());

async function dump(label, conn) {
  const sigs = await conn.getSignaturesForAddress(launch, { limit: 20 });
  console.log(`\n== ${label}: ${sigs.length} sigs`);
  for (const s of sigs) {
    const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
    if (!tx) { console.log(' ', s.signature.slice(0, 8), 'blockTime', s.blockTime, '-> tx NOT FOUND'); continue; }
    const msg = tx.transaction.message;
    const keys = msg.staticAccountKeys ?? msg.accountKeys;
    const ixs = msg.compiledInstructions ?? msg.instructions;
    const names = [];
    for (const ix of ixs) {
      const pid = keys[ix.programIdIndex];
      if (!pid.equals(PROGRAM_ID)) { names.push(`(${pid.toBase58().slice(0, 4)})`); continue; }
      const data = Buffer.from(ix.data ?? ix.dataBase58 ?? [], typeof ix.data === 'string' ? 'base64' : undefined);
      const dec = coder.decode(data);
      if (!dec) { names.push('?'); continue; }
      const args = Object.entries(dec.data).map(([k, v]) => `${k}=${v}`).join(',');
      names.push(`${dec.name}(${args})`);
      // signer = first required-signature key
    }
    console.log(' ', s.signature.slice(0, 8), 'blockTime', s.blockTime, 'signer', keys[0].toBase58().slice(0, 6), '->', names.join(' | '));
  }
}

await dump('L1 devnet', l1);

const r = await fetch(`${ROUTER}/getDelegationStatus`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getDelegationStatus', params: [launch.toBase58()] }),
}).then((x) => x.json());
console.log('\nrouter says:', JSON.stringify(r.result ?? r.error));
const fqdn = r.result?.fqdn;
if (fqdn) await dump(`ER ${fqdn}`, new Connection(fqdn, 'confirmed'));
