// How the bot studies a coin before buying it. Every live trade on the coin's
// bonding curve goes on a "tape". The tape becomes plain numbers (real
// buyers, money in and out, buy pressure, whales, what the creator is doing,
// momentum) and those become a 0-100 score with reasons, plus hard "no"s.
// Everything here is plain math on numbers, so it is easy to test.

const clamp01 = (x) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);
const DUST_SOL = 0.02; // buys smaller than this don't count as a real buyer (bot farms spray dust buys)

export class Tape {
  /** ignore: wallets that aren't real demand (the bot itself, the mayhem agent). */
  constructor({ mint, creator = null, ignore = [] } = {}) {
    this.mint = mint;
    this.creator = creator;
    this.ignore = new Set(ignore.filter(Boolean));
    this.trades = [];
    this.keys = new Set();
    this.lastAt = 0;
  }

  setCreator(c) { if (c && !this.creator) this.creator = c; }
  addIgnore(a) { if (a) this.ignore.add(a); }

  /** Add one decoded TradeEvent seen at time t (ms). Returns the stored trade, or null if it's a duplicate. */
  add(ev, t, sig = '') {
    if (!ev || ev.mint !== this.mint) return null;
    const key = sig + ':' + ev.user + ':' + (ev.isBuy ? 'b' : 's') + ':' + ev.tokenAmount + ':' + ev.solAmount;
    if (this.keys.has(key)) return null;
    this.keys.add(key);
    const vSol = Number(ev.virtualSolReserves), vTok = Number(ev.virtualTokenReserves);
    const tr = {
      t, sig, key, user: ev.user, buy: !!ev.isBuy,
      sol: Number(ev.solAmount) / 1e9,
      tok: Number(ev.tokenAmount),
      price: vTok > 0 ? vSol / vTok : 0,
      rSol: Number(ev.realSolReserves) / 1e9,
      reserves: { virtualTokenReserves: ev.virtualTokenReserves, virtualQuoteReserves: ev.virtualSolReserves, realTokenReserves: ev.realTokenReserves, realQuoteReserves: ev.realSolReserves },
    };
    this.trades.push(tr);
    if (this.trades.length > 1500) {
      const drop = this.trades.splice(0, this.trades.length - 1200);
      for (const d of drop) this.keys.delete(d.key);
    }
    if (t > this.lastAt) this.lastAt = t;
    return tr;
  }

  last() { return this.trades[this.trades.length - 1] || null; }
}

/** Numbers for the trades between `from` and `to` (ms). */
export function measure(tape, from = 0, to = Infinity) {
  const list = tape.trades.filter((x) => x.t >= from && x.t <= to);
  const wallets = new Map();
  for (const x of list) {
    let w = wallets.get(x.user);
    if (!w) { w = { buySol: 0, sellSol: 0, buys: 0, sells: 0, tokIn: 0, tokOut: 0 }; wallets.set(x.user, w); }
    if (x.buy) { w.buySol += x.sol; w.buys++; w.tokIn += x.tok; } else { w.sellSol += x.sol; w.sells++; w.tokOut += x.tok; }
  }
  const isFlipper = (w) => w.buys >= 2 && w.sells >= 2; // churning: volume bots, the mayhem agent
  let buySol = 0, sellSol = 0, buys = 0, sells = 0, uniqueBuyers = 0, topBuy = 0, flippers = 0, ignoredSol = 0;
  let creatorSoldSol = 0, creatorSells = 0, creatorTokOut = 0, creatorBoughtSol = 0, biggestSell = 0;
  for (const [user, w] of wallets) {
    if (tape.ignore.has(user)) { ignoredSol += w.buySol + w.sellSol; continue; }
    if (user === tape.creator) {
      creatorSoldSol += w.sellSol; creatorSells += w.sells; creatorTokOut += w.tokOut; creatorBoughtSol += w.buySol;
      sellSol += w.sellSol; sells += w.sells; // the creator selling is real selling
      continue;
    }
    if (isFlipper(w)) { flippers++; ignoredSol += w.buySol + w.sellSol; continue; }
    buySol += w.buySol; sellSol += w.sellSol; buys += w.buys; sells += w.sells;
    if (w.buySol >= DUST_SOL) uniqueBuyers++;
    if (w.buySol > topBuy) topBuy = w.buySol;
  }
  for (const x of list) if (!x.buy && !tape.ignore.has(x.user) && x.sol > biggestSell) biggestSell = x.sol;
  const first = list[0], last = list[list.length - 1];
  let peak = 0, low = Infinity;
  for (const x of list) { if (x.price > peak) peak = x.price; if (x.price < low) low = x.price; }
  const realTrades = list.filter((x) => !tape.ignore.has(x.user)).length;
  return {
    trades: list.length, realTrades, buys, sells, buySol, sellSol, netSol: buySol - sellSol,
    buyRatio: buySol + sellSol > 0 ? buySol / (buySol + sellSol) : 0.5,
    uniqueBuyers, topShare: buySol > 0 ? topBuy / buySol : 0, flippers, ignoredSol,
    creatorSoldSol, creatorSells, creatorTokOut, creatorBoughtSol, biggestSell,
    firstPrice: first?.price || 0, lastPrice: last?.price || 0, peakPrice: peak, lowPrice: low === Infinity ? 0 : low,
    change: first && first.price > 0 ? last.price / first.price - 1 : 0,
    drawdown: peak > 0 && last ? 1 - last.price / peak : 0,
    lastAt: last?.t || 0, rSol: last?.rSol ?? null,
  };
}

/**
 * The study verdict for a coin.
 * ctx: { tape, studyStart, now, coin: { creator, devBuyTokens, isMayhemMode }, curve: { complete, solPaired,
 *        isCashbackCoin, depth }, solRaised, vsLaunch, progress, peakMcap2m, mcap, rules, pickiness }
 * Returns { ok, score, need, parts: [{ key, label, pts, max, note }], vetoes: [text], reason, m }.
 */
export function judge(ctx) {
  const { tape, studyStart, now, coin = {}, curve = {}, rules } = ctx;
  const e = rules.entry;
  const mayhem = !!(coin.isMayhemMode || curve.isMayhemMode);
  const k = mayhem ? (rules.mayhemStrictness || 1.25) : 1; // mayhem coins must look stronger
  // A short study sees fewer trades: volume bars scale with its length (quality bars don't).
  // The last minute of price history (from the bot's price checks) fills in the rest.
  const studyMs = Math.max(1000, ctx.studyMs || now - studyStart);
  const f = Math.max(0.2, Math.min(1, studyMs / 45000));
  const half = Math.max(5000, Math.min(15000, studyMs / 2));
  const m = measure(tape, studyStart, now);
  const recent = measure(tape, now - half, now);
  const before = measure(tape, now - 2 * half, now - half);
  const inflow60 = Number.isFinite(ctx.inflow60) ? ctx.inflow60 : null;
  const rise60 = Number.isFinite(ctx.rise60) ? ctx.rise60 : null;
  const vetoes = [];
  const veto = (t) => vetoes.push(t);

  // ---- hard no's ----
  if (curve.complete) veto('Already graduated');
  if (curve.solPaired === false || curve.depth > 0) veto('Not a SOL coin');
  if (curve.isCashbackCoin) veto('Unsupported coin type');
  const devTok = coin.devBuyTokens ? Number(coin.devBuyTokens) : 0;
  const creatorDumped = m.creatorSoldSol >= 0.5 || (devTok > 0 && m.creatorTokOut >= devTok * 0.5) || (ctx.creatorSoldBefore === true);
  if (creatorDumped) veto('Creator is selling');
  const minTrades = Math.max(4, Math.ceil(e.minTrades * f));
  if (m.trades < minTrades) veto(`Too little trading (${m.trades} trades)`);
  const minBuyers = Math.max(mayhem ? 4 : 3, Math.ceil(e.minBuyers * k * f));
  if (m.uniqueBuyers < minBuyers) veto(`Only ${m.uniqueBuyers} real buyers (needs ${minBuyers})`);
  const minRatio = mayhem ? Math.max(e.minBuyRatio, 0.62) : e.minBuyRatio;
  if (m.buyRatio < minRatio) veto('More selling than buying');
  const minNet = e.minNetSol * k * f;
  if (m.netSol < minNet || (inflow60 !== null && inflow60 < e.minNetSol * 0.5)) veto(`Not enough money coming in (${m.netSol.toFixed(2)} SOL)`);
  if (m.buySol > 0 && m.topShare > e.maxTopShare) veto('One wallet is doing most of the buying');
  const minRise = e.minRise ?? 0.1;
  if (m.change < 0) veto('Price is dropping right now');
  else if (m.change < minRise * f && (rise60 === null || rise60 < minRise)) veto(`Price isn't climbing (+${Math.round(m.change * 100)}% while studied)`);
  const dd2m = ctx.peakMcap2m > 0 && ctx.mcap > 0 ? 1 - ctx.mcap / ctx.peakMcap2m : 0;
  const drawdown = Math.max(dd2m, m.drawdown);
  if (drawdown * 100 > e.maxDrawdownPct) veto(`Already ${Math.round(drawdown * 100)}% off its high`);
  if (ctx.solRaised !== undefined && ctx.solRaised !== null) {
    if (ctx.solRaised < e.minSolRaised) veto(`Too little SOL in it (${ctx.solRaised.toFixed(1)})`);
  }
  if (ctx.progress !== undefined && ctx.progress !== null && ctx.progress > e.maxProgress) veto('Too close to graduating');
  if (ctx.vsLaunch !== null && ctx.vsLaunch !== undefined && ctx.vsLaunch < e.minVsLaunch) veto('Not clearly above its launch price');
  if (m.lastAt && now - m.lastAt > 15000) veto('Trading went quiet');
  if (mayhem) {
    if (m.realTrades < Math.max(minTrades, 4) || m.ignoredSol > (m.buySol + m.sellSol) * 1.5) veto('Mostly the mayhem bot trading');
    // still climbing at the end, and the buying isn't fading
    const climbing = m.change >= 0.12 * Math.max(f, 0.5) || (rise60 !== null && rise60 >= 0.15);
    const flying = climbing && recent.netSol > 0 && recent.netSol >= before.netSol * 0.8 && recent.change >= 0;
    if (!flying) veto('Mayhem coin is not flying up yet');
  }

  // ---- score ----
  const parts = [];
  const part = (key, label, max, x, note) => parts.push({ key, label, max, pts: Math.round(max * clamp01(x) * 10) / 10, note });
  const lo = e.minBuyers * 0.5 * f, hi = Math.max(lo + 2, e.minBuyers * 2.5 * f);
  part('buyers', 'Real buyers', 25, (m.uniqueBuyers - lo) / (hi - lo), `${m.uniqueBuyers} wallets`);
  part('money', 'Money coming in', 20, Math.max(m.netSol / (e.minNetSol * 3 * f), (inflow60 ?? 0) / (e.minNetSol * 3)), `${m.netSol >= 0 ? '+' : ''}${m.netSol.toFixed(2)} SOL net${inflow60 !== null ? `, ${inflow60 >= 0 ? '+' : ''}${inflow60.toFixed(1)} in 1 min` : ''}`);
  part('pressure', 'Buy pressure', 15, (m.buyRatio - 0.5) / 0.35, `${Math.round(m.buyRatio * 100)}% buys`);
  const accel = recent.netSol > 0 && recent.netSol >= before.netSol * 0.9;
  const move = Math.max(m.change / (0.3 * f), (rise60 ?? 0) / 0.3);
  part('momentum', 'Momentum', 15, (clamp01(move) * 10 + (accel ? 5 : 0)) / 15, `${m.change >= 0 ? '+' : ''}${Math.round(m.change * 100)}%${rise60 !== null ? ` (${rise60 >= 0 ? '+' : ''}${Math.round(rise60 * 100)}% in 1 min)` : ''}${accel ? ', speeding up' : ''}`);
  part('spread', 'Spread out', 10, (0.4 - m.topShare) / 0.25, `top buyer ${Math.round(m.topShare * 100)}%`);
  part('holding', 'Holding up', 10, (0.25 - drawdown) / 0.2, drawdown > 0.005 ? `${Math.round(drawdown * 100)}% off high` : 'at its high');
  part('creator', 'Creator', 5, m.creatorSoldSol > 0.05 ? 0 : 1, m.creatorSoldSol > 0.05 ? `sold ${m.creatorSoldSol.toFixed(2)} SOL` : 'not selling');
  const score = Math.round(parts.reduce((a, p) => a + p.pts, 0));
  const need = Math.min(95, e.minScore + (ctx.pickiness || 0) + (mayhem ? 5 : 0));
  if (!vetoes.length && score < need) vetoes.push(`Score ${score}, needs ${need}`);
  const ok = vetoes.length === 0;
  return { ok, score, need, parts, vetoes, reason: ok ? `Score ${score}: strong buying` : vetoes[0], mayhem, m, at: now };
}

/** Problems bad enough to stop studying a coin early. */
export function fatalDuringStudy(tape, studyStart, now, coin = {}) {
  const m = measure(tape, studyStart, now);
  const devTok = coin.devBuyTokens ? Number(coin.devBuyTokens) : 0;
  if (m.creatorSoldSol >= 0.5 || (devTok > 0 && m.creatorTokOut >= devTok * 0.5)) return 'Creator is selling';
  if (m.trades >= 4 && m.drawdown > 0.35) return 'Price is collapsing';
  if (now - studyStart > 20000 && m.trades === 0) return 'Nobody is trading it';
  if (m.lastAt && now - m.lastAt > 25000) return 'Trading went quiet';
  return null;
}

/**
 * Live signals for a coin the bot holds (used by the exit rules).
 * Returns { creatorSelling, bigDump, sellersWin, strength, net60, lastAt }.
 */
export function flowSignals(tape, now, { since = 0 } = {}) {
  if (!tape || !tape.trades.length) return null;
  const from = Math.max(since, now - 60000);
  const m60 = measure(tape, from, now);
  const m30 = measure(tape, Math.max(since, now - 30000), now);
  const m20 = measure(tape, Math.max(since, now - 20000), now);
  const held = measure(tape, since, now);
  let bigDump = false;
  for (const x of tape.trades) {
    if (x.t < Math.max(since, now - 10000) || x.buy || tape.ignore.has(x.user)) continue;
    const before = (x.rSol || 0) + x.sol;
    if (x.sol >= 1 && before > 0 && x.sol / before >= 0.12) bigDump = true;
  }
  const creatorSelling = m60.creatorSoldSol >= 0.1 || held.creatorSoldSol >= 0.3;
  const sellersWin = m30.sellSol >= 0.5 && m30.sellSol >= 2 * m30.buySol;
  // 0..1: how hard it's going up right now
  const strength = clamp01((m20.netSol > 0 ? clamp01(m20.netSol / 2) * 0.5 : 0) + clamp01(m20.change / 0.15) * 0.3 + (m20.buyRatio > 0.65 ? 0.2 : 0));
  return { creatorSelling, bigDump, sellersWin, strength, net60: m60.netSol, lastAt: m60.lastAt || tape.lastAt };
}
