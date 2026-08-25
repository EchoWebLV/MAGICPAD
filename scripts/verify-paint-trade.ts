/* node --experimental-strip-types scripts/verify-paint-trade.ts */
import {
  bumpBuy, emptyPos, escrowDepositAdd, mergeHist, posCaughtUp, pushPending, unmatchedLocals,
} from '../apps/web/lib/paint-trade.ts';
import { MIN_DEPOSIT } from '../apps/web/lib/magicpad.ts';
import type { HistRow } from '../apps/web/lib/history.ts';

const LAMPORTS = 1_000_000_000;
let fails = 0;
function check(name: string, ok: boolean) {
  if (!ok) { fails += 1; console.error('FAIL', name); }
  else console.log('ok  ', name);
}

const actor = 'You111111111111111111111111111111111111111';
const local = (n: number, sol: number): HistRow => ({
  sig: `local:${n}`, at: n, er: true, kind: 'BUY', signer: actor, actor, sol,
});
const chain = (sig: string, sol: number): HistRow => ({
  sig, at: 1, er: true, kind: 'BUY', signer: actor, actor, sol,
});

const twoLocal = [local(1, 0.1 * LAMPORTS), local(2, 0.1 * LAMPORTS)];
const oneChain = [chain('real1', 0.1 * LAMPORTS)];
const extra = unmatchedLocals(oneChain, twoLocal);
check('same-size buys match one-for-one', extra.length === 1 && extra[0].sig === 'local:2');

const merged = mergeHist(oneChain, twoLocal);
check('merge keeps the unmatched local in front', merged[0].sig === 'local:2' && merged[1].sig === 'real1');

const bothChain = [chain('real1', 0.1 * LAMPORTS), chain('real2', 0.1 * LAMPORTS)];
check('both same-size chain rows absorb both locals', unmatchedLocals(bothChain, twoLocal).length === 0);

check('locals do not match other locals', unmatchedLocals(twoLocal, [local(3, 0.1 * LAMPORTS)]).length === 1);

check('first buy escrows max(size, floor)', escrowDepositAdd(null, 0.1 * LAMPORTS, 0) === 0.1 * LAMPORTS);
check('tiny first buy still hits the floor', escrowDepositAdd(null, 0.005 * LAMPORTS, 0) === MIN_DEPOSIT);

const pos = { ...emptyPos(), deposit: 0.1 * LAMPORTS, solSpent: 0.1 * LAMPORTS };
check('top-up is the shortfall, not an extra buy', escrowDepositAdd(pos, 0.1 * LAMPORTS, 0) === 0.1 * LAMPORTS);
check('inside escrow adds nothing', escrowDepositAdd({ ...pos, deposit: 0.5 * LAMPORTS }, 0.1 * LAMPORTS, 0.4 * LAMPORTS) === 0);

const painted = { ...emptyPos(), deposit: 100, solSpent: 100, solProceeds: 0 };
check('stale session is not caught up', !posCaughtUp({ ...painted, solSpent: 0, deposit: 0 }, painted));
check('caught when spent/deposit have moved', posCaughtUp(painted, painted));
check('no session yet is not caught up', !posCaughtUp(null, painted));

const live = {
  virtualSol: 30_000_000_000n, virtualTok: 1_073_000_000_000_000n,
  realSolRaised: 0, tokensSold: 0, sessionsOpened: 0, state: 0,
};
const b1 = bumpBuy(live, null, 100, 1n, 100);
const b2 = bumpBuy(b1.live, b1.pos, 100, 1n, 100);
check('second buy does not increment traders', b2.live.sessionsOpened === 1);
check('second buy stacks spent', b2.pos.solSpent === 200 && b2.pos.deposit === 200);

const hold = pushPending(null, 30n, b1.pos, local(1, 100));
const hold2 = pushPending(hold, 99n, b2.pos, local(2, 100));
check('pending keeps the original baseline vs', hold2.vs === 30n && hold2.rows.length === 2);

if (fails) { console.error(fails, 'failed'); process.exit(1); }
console.log('all paint-trade checks passed');
