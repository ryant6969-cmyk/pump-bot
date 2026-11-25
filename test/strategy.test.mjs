// The buy and sell rules on their own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { STYLES, DEFAULT_SETTINGS, resolveRules, evaluateEntry, evaluateExit, evaluateHolders } from '../js/strategy.js';

const rules = resolveRules({ ...DEFAULT_SETTINGS, style: 'balanced' });
const NOW = 1_000_000;
const curve = { complete: false, isMayhemMode: false, isCashbackCoin: false, solPaired: true, depth: 0 };
function coin(mcaps, { age = 120, progress = 0.3, stepMs = 2500, c = curve } = {}) {
  const snaps = mcaps.map((m, i) => ({ t: NOW - (mcaps.length - 1 - i) * stepMs, mcap: m, progress }));
  return { createdAt: NOW - age * 1000, snaps, curve: c };
}
const rising = Array.from({ length: 30 }, (_, i) => 40 * (1 + i * 0.012));

test('user overrides are clamped to safe ranges; junk is ignored', () => {
  const r = resolveRules({ ...DEFAULT_SETTINGS, tradeSol: 1000, stopLossPct: 200, maxOpen: 2.6, takeProfitPct: 'abc', trailDropPct: -5 });
  assert.equal(r.tradeSol, 100);
  assert.equal(r.stopLossPct, 95);
  assert.equal(r.maxOpen, 3);
  assert.equal(r.takeProfitPct, STYLES.balanced.takeProfitPct);
  assert.equal(r.trailDropPct, 1);
  assert.equal(resolveRules({ style: 'nope' }).label, 'Balanced');
  assert.equal(resolveRules({ ...DEFAULT_SETTINGS, speed: 'warp' }).speed, 'fast');
});

test('entry: buys a steady climber, refuses everything else with a reason', () => {
  assert.equal(evaluateEntry(coin(rising), rules, NOW).ok, true);
  assert.match(evaluateEntry(coin([40, 41]), rules, NOW).reason, /Collecting/);
  assert.match(evaluateEntry(coin(rising, { c: { ...curve, complete: true } }), rules, NOW).reason, /graduated/);
  assert.match(evaluateEntry(coin(rising, { c: { ...curve, solPaired: false } }), rules, NOW).reason, /SOL/);
  assert.match(evaluateEntry(coin(rising, { c: { ...curve, isCashbackCoin: true } }), rules, NOW).reason, /type/);
  assert.match(evaluateEntry(coin(rising, { c: { ...curve, isMayhemMode: true } }), rules, NOW).reason, /Mayhem/);
  assert.equal(evaluateEntry(coin(rising, { c: { ...curve, isMayhemMode: true } }), { ...rules, skipMayhem: false }, NOW).ok, true);
  assert.match(evaluateEntry(coin(rising, { age: 10 }), rules, NOW).reason, /Too new/);
  assert.match(evaluateEntry(coin(rising, { age: 3600 }), rules, NOW).reason, /Too old/);
  assert.match(evaluateEntry(coin(rising, { progress: 0.01 }), rules, NOW).reason, /buyers/);
  assert.match(evaluateEntry(coin(rising, { progress: 0.9 }), rules, NOW).reason, /graduating/);
  assert.match(evaluateEntry(coin(rising), rules, NOW + 60_000).reason, /stale/);
  assert.match(evaluateEntry(coin([...rising, rising[29] * 0.8]), rules, NOW).reason, /Falling/);
  assert.match(evaluateEntry(coin([...rising.slice(0, 26), 55, 50, 56, 49]), rules, NOW).reason, /Falling|Choppy/);
  assert.match(evaluateEntry(coin(Array.from({ length: 30 }, (_, i) => 40 + i * 0.05)), rules, NOW).reason, /Needs \+15%/);
});

test('holders: excludes the curve, then checks top wallet, top 10 and creator', () => {
  const supply = 1_000_000n * 10n ** 6n;
  const h = (pct, address = 'w' + pct + Math.random()) => ({ address, amount: (supply * BigInt(Math.round(pct * 100))) / 10_000n });
  const spread = [h(60, 'curve'), ...Array.from({ length: 15 }, () => h(1.5))];
  assert.equal(evaluateHolders({ holders: spread, supply, excludeAddresses: ['curve'] }, rules).ok, true);
  assert.equal(evaluateHolders({ holders: spread, supply }, rules).ok, false, 'the curve itself would look like a whale');
  assert.match(evaluateHolders({ holders: [h(60, 'curve'), h(12)], supply, excludeAddresses: ['curve'] }, rules).reason, /One wallet holds 12/);
  assert.match(evaluateHolders({ holders: [h(60, 'curve'), ...Array.from({ length: 10 }, () => h(4))], supply, excludeAddresses: ['curve'] }, rules).reason, /Top 10/);
  assert.match(evaluateHolders({ holders: [h(60, 'curve'), h(9, 'dev'), h(1)], supply, excludeAddresses: ['curve'], devAccount: 'dev' }, rules).reason, /Creator holds 9/);
});

test('exit: take profit, stop loss, trailing stop, time limit, graduation', () => {
  const pos = { costLamports: 100n, peakValueLamports: 100n, openedAt: NOW - 60_000 };
  assert.equal(evaluateExit(pos, 151, rules, {}, NOW).reason, 'Take profit');
  assert.equal(evaluateExit(pos, 79, rules, {}, NOW).reason, 'Stop loss');
  assert.equal(evaluateExit(pos, 110, rules, {}, NOW).sell, false);
  // up 40% at the peak, now 22% below the peak -> trailing stop
  assert.equal(evaluateExit({ ...pos, peakValueLamports: 140n }, 122, rules, {}, NOW).reason, 'Trailing stop');
  assert.equal(evaluateExit({ ...pos, peakValueLamports: 140n }, 125, rules, {}, NOW).sell, false);
  // the peak never reached the trailing start -> no trailing stop
  assert.equal(evaluateExit({ ...pos, peakValueLamports: 120n }, 101, rules, {}, NOW).sell, false);
  assert.equal(evaluateExit({ ...pos, openedAt: NOW - 9 * 60_000 }, 105, rules, {}, NOW).reason, 'Time limit');
  assert.equal(evaluateExit(pos, 105, rules, { progress: 0.96 }, NOW).reason, 'About to graduate');
  assert.equal(evaluateExit(pos, 105, { ...rules, sellBeforeGraduation: false }, { progress: 0.96 }, NOW).sell, false);
  assert.equal(evaluateExit(pos, 105, rules, { complete: true }, NOW).reason, 'Coin graduated');
  assert.equal(evaluateExit({ ...pos, costLamports: 0n }, 105, rules, {}, NOW).sell, false);
});
