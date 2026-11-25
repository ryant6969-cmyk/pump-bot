// The bot's rules: the three styles, when to buy, when to sell.
// Everything here is plain math on numbers, so it is easy to test.

export const STYLES = {
  careful: {
    label: 'Careful',
    blurb: 'Small trades, quick exits, strict checks. Fewer trades.',
    tradeSol: 0.02, maxOpen: 1, takeProfitPct: 30, stopLossPct: 15,
    trailStartPct: 20, trailDropPct: 10, maxHoldMin: 5, dailyLossSol: 0.1,
    buySlippagePct: 15, sellSlippagePct: 20,
    entry: { minAgeSec: 45, maxAgeMin: 8, minProgress: 0.10, maxProgress: 0.60, minRise60: 20, minRise30: 5, maxTop1Pct: 8, maxTop10Pct: 30, maxDevPct: 5 },
  },
  balanced: {
    label: 'Balanced',
    blurb: 'Medium trades, medium targets. A good place to start.',
    tradeSol: 0.05, maxOpen: 2, takeProfitPct: 50, stopLossPct: 20,
    trailStartPct: 25, trailDropPct: 12, maxHoldMin: 8, dailyLossSol: 0.25,
    buySlippagePct: 15, sellSlippagePct: 25,
    entry: { minAgeSec: 30, maxAgeMin: 10, minProgress: 0.08, maxProgress: 0.70, minRise60: 15, minRise30: 3, maxTop1Pct: 10, maxTop10Pct: 35, maxDevPct: 8 },
  },
  aggressive: {
    label: 'Aggressive',
    blurb: 'Bigger trades, bigger targets, looser checks. Swings both ways.',
    tradeSol: 0.1, maxOpen: 3, takeProfitPct: 100, stopLossPct: 30,
    trailStartPct: 40, trailDropPct: 15, maxHoldMin: 15, dailyLossSol: 0.5,
    buySlippagePct: 20, sellSlippagePct: 30,
    entry: { minAgeSec: 20, maxAgeMin: 15, minProgress: 0.05, maxProgress: 0.80, minRise60: 10, minRise30: 2, maxTop1Pct: 12, maxTop10Pct: 45, maxDevPct: 12 },
  },
};

export const SPEEDS = {
  normal: { label: 'Normal', microLamports: 200_000, maxMicroLamports: 400_000 },
  fast: { label: 'Fast', microLamports: 1_000_000, maxMicroLamports: 2_000_000 },
  turbo: { label: 'Turbo', microLamports: 3_000_000, maxMicroLamports: 6_000_000 },
};

// Settings the user can change; anything left null uses the style's value.
export const DEFAULT_SETTINGS = {
  style: 'balanced',
  mode: 'practice', // 'practice' | 'real'
  autoBuy: true,
  speed: 'fast',
  tradeSol: null, maxOpen: null, takeProfitPct: null, stopLossPct: null,
  trailStartPct: null, trailDropPct: null, maxHoldMin: null, dailyLossSol: null,
  sellBeforeGraduation: true,
  skipMayhem: true,
  keepSolReserve: 0.01,
  practiceStartSol: 1,
};

const NUMERIC_LIMITS = {
  tradeSol: [0.001, 100], maxOpen: [1, 10], takeProfitPct: [1, 10000], stopLossPct: [1, 95],
  trailStartPct: [0, 10000], trailDropPct: [1, 90], maxHoldMin: [0.5, 1440], dailyLossSol: [0.001, 1000],
};

/** Effective rules = style defaults + the user's overrides (validated). */
export function resolveRules(settings) {
  const style = STYLES[settings.style] || STYLES.balanced;
  const r = { ...style, entry: { ...style.entry } };
  for (const [k, [lo, hi]] of Object.entries(NUMERIC_LIMITS)) {
    const v = settings[k];
    if (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))) {
      r[k] = Math.min(hi, Math.max(lo, Number(v)));
    }
  }
  r.maxOpen = Math.round(r.maxOpen);
  r.sellBeforeGraduation = settings.sellBeforeGraduation !== false;
  r.skipMayhem = settings.skipMayhem !== false;
  r.speed = SPEEDS[settings.speed] ? settings.speed : 'fast';
  r.keepSolReserve = Math.max(0.005, Number(settings.keepSolReserve) || 0.01);
  return r;
}

/** Market cap (SOL) closest to `t` from the snapshots, using the earliest one if the coin is younger. */
function mcapAt(snaps, t) {
  let best = snaps[0];
  for (const s of snaps) { if (s.t <= t) best = s; else break; }
  return best.mcap;
}

/**
 * Should the bot buy this coin now (before the holder check)?
 * coin: { createdAt, snaps: [{ t, mcap, progress }], curve: { complete, isMayhemMode, isCashbackCoin, solPaired, depth } }
 * Returns { ok, reason, rise60, rise30 }.
 */
export function evaluateEntry(coin, rules, now = Date.now()) {
  const e = rules.entry;
  const snaps = coin.snaps || [];
  const c = coin.curve;
  if (!c || snaps.length < 3) return { ok: false, reason: 'Collecting price data' };
  if (c.complete) return { ok: false, reason: 'Already graduated' };
  if (!c.solPaired || c.depth > 0) return { ok: false, reason: 'Not a SOL coin' };
  if (c.isCashbackCoin) return { ok: false, reason: 'Unsupported coin type' };
  if (rules.skipMayhem && c.isMayhemMode) return { ok: false, reason: 'Mayhem coin (skipped)' };
  const ageSec = (now - coin.createdAt) / 1000;
  if (ageSec < e.minAgeSec) return { ok: false, reason: `Too new (${Math.round(ageSec)}s)` };
  if (ageSec > e.maxAgeMin * 60) return { ok: false, reason: 'Too old' };
  const last = snaps[snaps.length - 1];
  if (now - last.t > 15000) return { ok: false, reason: 'Price data is stale' };
  if (last.progress < e.minProgress) return { ok: false, reason: 'Not enough buyers yet' };
  if (last.progress > e.maxProgress) return { ok: false, reason: 'Too close to graduating' };
  const m60 = mcapAt(snaps, last.t - 60000);
  const m30 = mcapAt(snaps, last.t - 30000);
  const rise60 = m60 > 0 ? (last.mcap / m60 - 1) * 100 : 0;
  const rise30 = m30 > 0 ? (last.mcap / m30 - 1) * 100 : 0;
  const recent = snaps.filter((s) => s.t >= last.t - 60000);
  const peak = Math.max(...recent.map((s) => s.mcap));
  if (last.mcap < peak * 0.9) return { ok: false, reason: 'Falling from its high', rise60, rise30 };
  const tail = snaps.slice(-4);
  let ups = 0;
  for (let i = 1; i < tail.length; i++) if (tail[i].mcap >= tail[i - 1].mcap) ups++;
  if (ups < 2) return { ok: false, reason: 'Choppy price', rise60, rise30 };
  if (rise60 < e.minRise60) return { ok: false, reason: `Needs +${e.minRise60}% in 1 min (now ${rise60 >= 0 ? '+' : ''}${rise60.toFixed(0)}%)`, rise60, rise30 };
  if (rise30 < e.minRise30) return { ok: false, reason: 'Momentum fading', rise60, rise30 };
  return { ok: true, reason: 'Rising fast', rise60, rise30 };
}

/**
 * Holder check. holders: [{ address, amount (BigInt) }] from getTokenLargestAccounts,
 * excludeAddresses: accounts that aren't real holders (the bonding curve's).
 */
export function evaluateHolders({ holders, supply, excludeAddresses = [], devAccount = null }, rules) {
  const e = rules.entry;
  if (!supply || supply <= 0n) return { ok: false, reason: 'Unknown supply' };
  const skip = new Set(excludeAddresses);
  const real = holders.filter((h) => !skip.has(h.address) && h.amount > 0n).sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
  const pct = (a) => Number((a * 1_000_000n) / supply) / 10_000;
  const top1 = real.length ? pct(real[0].amount) : 0;
  const top10 = pct(real.slice(0, 10).reduce((s, h) => s + h.amount, 0n));
  const dev = devAccount ? pct(real.find((h) => h.address === devAccount)?.amount ?? 0n) : 0;
  if (top1 > e.maxTop1Pct) return { ok: false, reason: `One wallet holds ${top1.toFixed(1)}%`, top1, top10, dev };
  if (top10 > e.maxTop10Pct) return { ok: false, reason: `Top 10 wallets hold ${top10.toFixed(0)}%`, top1, top10, dev };
  if (dev > e.maxDevPct) return { ok: false, reason: `Creator holds ${dev.toFixed(1)}%`, top1, top10, dev };
  return { ok: true, reason: 'Holders look spread out', top1, top10, dev };
}

/**
 * Should the bot sell this position now?
 * pos: { costLamports, peakValueLamports, openedAt }, value: current value (lamports, after fees)
 * info: { progress, complete }
 */
export function evaluateExit(pos, value, rules, info = {}, now = Date.now()) {
  const cost = Number(pos.costLamports);
  if (!(cost > 0)) return { sell: false };
  const v = Number(value);
  const pnlPct = (v / cost - 1) * 100;
  const peak = Math.max(Number(pos.peakValueLamports || 0), v);
  const peakPnl = (peak / cost - 1) * 100;
  if (info.complete) return { sell: true, reason: 'Coin graduated', pnlPct };
  if (pnlPct >= rules.takeProfitPct) return { sell: true, reason: 'Take profit', pnlPct };
  if (pnlPct <= -rules.stopLossPct) return { sell: true, reason: 'Stop loss', pnlPct };
  if (rules.trailStartPct > 0 && peakPnl >= rules.trailStartPct && v <= peak * (1 - rules.trailDropPct / 100)) {
    return { sell: true, reason: 'Trailing stop', pnlPct };
  }
  if (now - pos.openedAt >= rules.maxHoldMin * 60000) return { sell: true, reason: 'Time limit', pnlPct };
  if (rules.sellBeforeGraduation && info.progress >= 0.95) return { sell: true, reason: 'About to graduate', pnlPct };
  return { sell: false, pnlPct };
}
