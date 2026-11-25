// The bot's rules: the three styles, which coins are worth studying, and
// when to sell. Everything here is plain math on numbers, so it is easy to test.
// (How a studied coin is scored lives in analyst.js.)

export const STYLES = {
  careful: {
    label: 'Careful',
    blurb: 'Only the strongest coins, small trades, quick exits.',
    tradeSol: 0.02, maxOpen: 1, takeProfitPct: 30, stopLossPct: 15,
    trailStartPct: 20, trailDropPct: 10, maxHoldMin: 6,
    buySlippagePct: 15, sellSlippagePct: 20,
    entry: {
      minAgeSec: 15, maxAgeMin: 15, scanMinSol: 1.5, maxProgress: 0.75,
      minSolRaised: 4, minBuyers: 12, minNetSol: 1.5, minBuyRatio: 0.6, maxTopShare: 0.3, minRise: 0.15,
      maxDrawdownPct: 20, minVsLaunch: 1.2, minTrades: 15, minScore: 78,
      maxTop1Pct: 8, maxTop10Pct: 30, maxDevPct: 5,
    },
  },
  balanced: {
    label: 'Balanced',
    blurb: 'Strict checks, medium trades. A good place to start.',
    tradeSol: 0.05, maxOpen: 2, takeProfitPct: 45, stopLossPct: 18,
    trailStartPct: 25, trailDropPct: 12, maxHoldMin: 10,
    buySlippagePct: 15, sellSlippagePct: 25,
    entry: {
      minAgeSec: 10, maxAgeMin: 20, scanMinSol: 1.0, maxProgress: 0.8,
      minSolRaised: 3, minBuyers: 8, minNetSol: 1.0, minBuyRatio: 0.55, maxTopShare: 0.4, minRise: 0.1,
      maxDrawdownPct: 25, minVsLaunch: 1.15, minTrades: 10, minScore: 70,
      maxTop1Pct: 10, maxTop10Pct: 35, maxDevPct: 8,
    },
  },
  aggressive: {
    label: 'Aggressive',
    blurb: 'More trades and bigger targets. Swings both ways.',
    tradeSol: 0.1, maxOpen: 3, takeProfitPct: 90, stopLossPct: 25,
    trailStartPct: 35, trailDropPct: 15, maxHoldMin: 15,
    buySlippagePct: 20, sellSlippagePct: 30,
    entry: {
      minAgeSec: 6, maxAgeMin: 30, scanMinSol: 0.6, maxProgress: 0.85,
      minSolRaised: 2, minBuyers: 6, minNetSol: 0.6, minBuyRatio: 0.52, maxTopShare: 0.45, minRise: 0.07,
      maxDrawdownPct: 30, minVsLaunch: 1.1, minTrades: 8, minScore: 62,
      maxTop1Pct: 12, maxTop10Pct: 45, maxDevPct: 12,
    },
  },
};

export const SPEEDS = {
  normal: { label: 'Normal', microLamports: 200_000, maxMicroLamports: 400_000 },
  fast: { label: 'Fast', microLamports: 1_000_000, maxMicroLamports: 2_000_000 },
  turbo: { label: 'Turbo', microLamports: 3_000_000, maxMicroLamports: 6_000_000 },
};

export const SETTINGS_VERSION = 4;

// Settings the user can change; anything left null uses the style's value.
export const DEFAULT_SETTINGS = {
  settingsVersion: SETTINGS_VERSION,
  style: 'balanced',
  mode: 'practice', // 'practice' | 'real'
  autoBuy: true,
  speed: 'fast',
  tradeSol: null, maxOpen: null, takeProfitPct: null, stopLossPct: null,
  trailStartPct: null, trailDropPct: null, maxHoldMin: null,
  sellBeforeGraduation: true,
  skipMayhem: false, // mayhem coins are allowed, with stricter checks
  studySec: 10,
  mayhemStudySec: 10,
  mayhemProfitMinUsd: 5,
  mayhemProfitMaxUsd: 10,
  keepSolReserve: 0.01,
  practiceStartSol: 1,
  pendingPracticeUsd: 0, // practice money to add once the SOL price is known
};

const NUMERIC_LIMITS = {
  tradeSol: [0.001, 100], maxOpen: [1, 10], takeProfitPct: [1, 10000], stopLossPct: [1, 95],
  trailStartPct: [0, 10000], trailDropPct: [1, 90], maxHoldMin: [0.5, 1440],
};

/** Bring settings saved by an older version up to date. */
export function migrateSettings(s) {
  const out = { ...s };
  const v = Number(out.settingsVersion) || 1;
  if (v < 2) out.skipMayhem = false; // v2: mayhem coins allowed, but only when the study says they're flying
  if (v < 3 && out.setupDone) out.pendingPracticeUsd = (Number(out.pendingPracticeUsd) || 0) + 500; // v3: a one-time $500 practice top-up
  if (v < 4) { // v4: 10-second studies (keeps a time the user picked themselves)
    if (out.studySec === undefined || Number(out.studySec) === 45) out.studySec = 10;
    if (out.mayhemStudySec === undefined || Number(out.mayhemStudySec) === 25) out.mayhemStudySec = 10;
  }
  out.settingsVersion = SETTINGS_VERSION;
  return out;
}

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
  r.skipMayhem = settings.skipMayhem === true;
  r.speed = SPEEDS[settings.speed] ? settings.speed : 'fast';
  r.keepSolReserve = Math.max(0.005, Number(settings.keepSolReserve) || 0.01);
  const num = (v, d, lo, hi) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.min(hi, Math.max(lo, Number(v))) : d);
  r.studySec = num(settings.studySec, 10, 5, 180);
  r.mayhemStudySec = num(settings.mayhemStudySec, 10, 5, 120);
  r.mayhemProfitMinUsd = num(settings.mayhemProfitMinUsd, 5, 0.5, 10000);
  r.mayhemProfitMaxUsd = Math.max(r.mayhemProfitMinUsd, num(settings.mayhemProfitMaxUsd, 10, 0.5, 10000));
  r.mayhemStrictness = 1.25;
  return r;
}

/** Market cap (SOL) closest to `t` from the snapshots, using the earliest one if the coin is younger. */
export function snapAt(snaps, t) {
  let best = snaps[0];
  for (const s of snaps) { if (s.t <= t) best = s; else break; }
  return best;
}

/**
 * Is this coin worth studying (watching its live trades) right now?
 * coin: { createdAt, snaps: [{ t, mcap, progress, sol, vsl }], curve: { complete, isMayhemMode, isCashbackCoin, solPaired, depth } }
 * Returns { ok, reason, inflow20 }.
 */
export function evaluateScan(coin, rules, now = Date.now()) {
  const e = rules.entry;
  const snaps = coin.snaps || [];
  const c = coin.curve;
  if (!c || snaps.length < 2) return { ok: false, reason: 'Collecting price data' };
  if (c.complete) return { ok: false, reason: 'Already graduated' };
  if (!c.solPaired || c.depth > 0) return { ok: false, reason: 'Not a SOL coin' };
  if (c.isCashbackCoin) return { ok: false, reason: 'Unsupported coin type' };
  if (rules.skipMayhem && c.isMayhemMode) return { ok: false, reason: 'Mayhem coin (skipped)' };
  const ageSec = (now - coin.createdAt) / 1000;
  if (ageSec < e.minAgeSec) return { ok: false, reason: `Too new (${Math.round(ageSec)}s)` };
  if (ageSec > e.maxAgeMin * 60) return { ok: false, reason: 'Too old' };
  const last = snaps[snaps.length - 1];
  if (now - last.t > 15000) return { ok: false, reason: 'Price data is stale' };
  if (last.sol < e.scanMinSol) return { ok: false, reason: 'Not enough buyers yet' };
  if (last.progress > e.maxProgress) return { ok: false, reason: 'Too close to graduating' };
  if (last.vsl !== null && last.vsl !== undefined && last.vsl < 1.05) return { ok: false, reason: 'Below its launch price' };
  const recent = snaps.filter((s) => s.t >= last.t - 120000);
  const peak = Math.max(...recent.map((s) => s.mcap));
  if (last.mcap < peak * 0.85) return { ok: false, reason: 'Falling from its high' };
  const ref = snapAt(snaps, last.t - 20000);
  const inflow20 = last.sol - ref.sol;
  const rise20 = ref.mcap > 0 ? last.mcap / ref.mcap - 1 : 0;
  if (inflow20 < 0.2 && rise20 < 0.03) return { ok: false, reason: 'Not moving', inflow20 };
  return { ok: true, reason: 'Worth a look', inflow20 };
}

/**
 * Holder check. holders: [{ address, amount (BigInt) }] from getTokenLargestAccounts,
 * excludeAddresses: accounts that aren't real holders (the bonding curve's, the mayhem agent's).
 */
export function evaluateHolders({ holders, supply, excludeAddresses = [], devAccount = null, devBought = null }, rules) {
  const e = rules.entry;
  if (!supply || supply <= 0n) return { ok: false, reason: 'Unknown supply' };
  const skip = new Set(excludeAddresses.filter(Boolean));
  const real = holders.filter((h) => !skip.has(h.address) && h.amount > 0n).sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
  const pct = (a) => Number((a * 1_000_000n) / supply) / 10_000;
  const top1 = real.length ? pct(real[0].amount) : 0;
  const top10 = pct(real.slice(0, 10).reduce((s, h) => s + h.amount, 0n));
  const devHeld = devAccount ? holders.find((h) => h.address === devAccount)?.amount ?? 0n : null;
  const dev = devHeld !== null ? pct(devHeld) : 0;
  if (top1 > e.maxTop1Pct) return { ok: false, reason: `One wallet holds ${top1.toFixed(1)}%`, top1, top10, dev };
  if (top10 > e.maxTop10Pct) return { ok: false, reason: `Top 10 wallets hold ${top10.toFixed(0)}%`, top1, top10, dev };
  if (dev > e.maxDevPct) return { ok: false, reason: `Creator holds ${dev.toFixed(1)}%`, top1, top10, dev };
  // getTokenLargestAccounts lists the top 20 only; a missing creator account means "small or none", which is fine
  if (devBought && devBought > 0n && devHeld !== null && (devHeld > 0n || holders.length < 20) && devHeld * 2n < devBought) {
    return { ok: false, reason: 'Creator already sold most of their coins', top1, top10, dev };
  }
  return { ok: true, reason: 'Holders look spread out', top1, top10, dev };
}

/**
 * Should the bot sell this position now?
 * pos: { costLamports, peakValueLamports, openedAt, mayhem, copiedFrom }
 * value: current value (lamports, after fees)
 * info: { progress, complete, flow (analyst.flowSignals), solUsd }
 * Returns { sell, reason, pnlPct }.
 */
export function evaluateExit(pos, value, rules, info = {}, now = Date.now()) {
  const cost = Number(pos.costLamports);
  if (!(cost > 0)) return { sell: false };
  const v = Number(value);
  const pnlPct = (v / cost - 1) * 100;
  const peak = Math.max(Number(pos.peakValueLamports || 0), v);
  const peakPnl = (peak / cost - 1) * 100;
  const flow = info.flow || null;
  const copy = !!pos.copiedFrom;
  // the coin itself is turning bad: get out first
  if (flow?.creatorSelling) return { sell: true, reason: 'Creator is selling', pnlPct };
  if (flow?.bigDump && pnlPct < rules.takeProfitPct) return { sell: true, reason: 'A big holder dumped', pnlPct };
  if (pnlPct <= -rules.stopLossPct) return { sell: true, reason: 'Stop loss', pnlPct };
  if (copy) return { sell: false, pnlPct }; // copied trades follow the wallet you copy (plus the safety exits above)
  if (info.complete) return { sell: true, reason: 'Coin graduated', pnlPct };
  if (pos.mayhem && info.solUsd > 0) {
    // mayhem coins: take a quick $5-$10, more only while it's still flying
    const profitUsd = ((v - cost) / 1e9) * info.solUsd;
    const strong = (flow?.strength ?? 0) >= 0.6;
    const target = strong ? rules.mayhemProfitMaxUsd : rules.mayhemProfitMinUsd;
    if (profitUsd >= target) return { sell: true, reason: `Took $${profitUsd.toFixed(2)} profit`, pnlPct };
    if (profitUsd >= rules.mayhemProfitMinUsd && flow && flow.strength < 0.3) return { sell: true, reason: `Took $${profitUsd.toFixed(2)} profit`, pnlPct };
  } else if (pnlPct >= rules.takeProfitPct) {
    return { sell: true, reason: 'Take profit', pnlPct };
  }
  if (rules.trailStartPct > 0 && peakPnl >= rules.trailStartPct && v <= peak * (1 - rules.trailDropPct / 100)) {
    return { sell: true, reason: 'Trailing stop', pnlPct };
  }
  if (flow?.sellersWin && pnlPct < rules.trailStartPct) return { sell: true, reason: 'Sellers took over', pnlPct };
  const heldMin = (now - pos.openedAt) / 60000;
  if (heldMin >= rules.maxHoldMin) return { sell: true, reason: 'Time limit', pnlPct };
  if (heldMin >= Math.max(2.5, rules.maxHoldMin * 0.4) && pnlPct > -10 && pnlPct < 5 && flow && flow.net60 <= 0) {
    return { sell: true, reason: 'Going nowhere', pnlPct };
  }
  if (rules.sellBeforeGraduation && info.progress >= 0.95) return { sell: true, reason: 'About to graduate', pnlPct };
  return { sell: false, pnlPct };
}
