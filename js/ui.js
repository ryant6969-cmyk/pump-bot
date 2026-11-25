// Everything on screen. Plain DOM, no framework. Every value that comes from
// the network or a coin (names, symbols, errors) is escaped before display.

import * as pump from './pump.js?v=2.3.0';
import { STYLES, SPEEDS, resolveRules } from './strategy.js?v=2.3.0';
import { isAddress } from './b58.js?v=2.3.0';

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const ICONS = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/></svg>',
  coins: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/></svg>',
  trades: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 9h10M7 13h6M7 17h4"/></svg>',
  wallets: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 7V5.5A1.5 1.5 0 0 0 17.5 4H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v3"/><path d="M3 6v12a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-3"/><path d="M21 12h-4a2 2 0 0 0 0 4h4z"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  share: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px"><path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>',
};

const HELIUS_SIGNUP = 'https://dashboard.helius.dev/';

/**
 * Update `el` to match `html` in place, keeping existing elements (so a
 * button being tapped isn't swapped out mid-tap, and typed input survives).
 */
export function patch(el, html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  morphChildren(el, tpl.content);
}
function morphChildren(from, to) {
  const a = [...from.childNodes];
  const b = [...to.childNodes];
  for (let i = 0; i < b.length; i++) {
    const n = b[i];
    const o = a[i];
    if (!o) { from.appendChild(n.cloneNode(true)); continue; }
    if (o.nodeType !== n.nodeType || (o.nodeType === 1 && o.tagName !== n.tagName)) { from.replaceChild(n.cloneNode(true), o); continue; }
    if (o.nodeType !== 1) { if (o.nodeValue !== n.nodeValue) o.nodeValue = n.nodeValue; continue; }
    for (const at of [...o.attributes]) if (!n.hasAttribute(at.name)) o.removeAttribute(at.name);
    for (const at of [...n.attributes]) if (o.getAttribute(at.name) !== at.value) o.setAttribute(at.name, at.value);
    if (o.tagName === 'TEXTAREA') continue;
    morphChildren(o, n);
  }
  for (let i = a.length - 1; i >= b.length; i--) from.removeChild(a[i]);
}

// ---------- formatting ----------
export function solNum(sol) {
  const a = Math.abs(sol);
  if (a >= 100) return sol.toFixed(1);
  if (a >= 1) return sol.toFixed(3);
  if (a >= 0.0001 || a === 0) return sol.toFixed(4);
  return sol.toExponential(1);
}
const toSol = (l) => (l === null || l === undefined ? 0 : pump.lamportsToSol(BigInt(l)));
function signed(sol) { return (sol > 0 ? '+' : sol < 0 ? '−' : '') + solNum(Math.abs(sol)); }
function pct(x, digits = 0) { if (!Number.isFinite(x)) return '–'; return (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(digits) + '%'; }
function ago(t, now = Date.now()) {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 5) return 'now';
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}
function agoText(t, now = Date.now()) { const a = ago(t, now); return a === 'now' ? 'just now' : a + ' ago'; }
function short(a) { return a ? a.slice(0, 4) + '…' + a.slice(-4) : ''; }
function hue(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; }
function avatar(symbol, mint) {
  const letters = String(symbol || '?').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase() || '?';
  const h = hue(mint);
  return `<span class="avatar" style="background:linear-gradient(135deg,hsl(${h} 42% 62%),hsl(${(h + 40) % 360} 38% 46%))">${esc(letters)}</span>`;
}
function cls(sol) { return sol > 0 ? 'up' : sol < 0 ? 'down' : ''; }
function clamp01(x) { return Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0)); }

/** A gold ring showing a 0-100 score. */
export function scoreRing(score, kind = '', big = false) {
  const has = score !== null && score !== undefined;
  const v = has ? Math.max(0, Math.min(100, Math.round(score))) : 0;
  const r = 15.5, C = 2 * Math.PI * r;
  return `<span class="score ${kind} ${big ? 'big' : ''}"><svg viewBox="0 0 36 36" aria-hidden="true"><circle class="trk" cx="18" cy="18" r="${r}"></circle><circle class="val" cx="18" cy="18" r="${r}" stroke-dasharray="${((C * v) / 100).toFixed(1)} ${C.toFixed(1)}"></circle></svg><b>${has ? v : '–'}</b></span>`;
}

/** A tiny market-cap line. */
export function sparkline(snaps, w = 64, h = 22) {
  const vals = (snaps || []).slice(-40).map((x) => x.mcap).filter((v) => v > 0);
  if (vals.length < 2) return `<svg class="spark flat" viewBox="0 0 ${w} ${h}" aria-hidden="true"></svg>`;
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || max * 0.01 || 1;
  const step = w / (vals.length - 1);
  const pts = vals.map((v, i) => `${(i * step).toFixed(1)},${(h - 2 - ((v - min) / span) * (h - 4)).toFixed(1)}`).join(' ');
  const a = vals[0], z = vals[vals.length - 1];
  const dir = z > a * 1.01 ? 'up' : z < a * 0.99 ? 'down' : 'flat';
  return `<svg class="spark ${dir}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}"></polyline></svg>`;
}

function isIos() { return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
function isStandalone() { return window.navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches; }

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch { return false; }
}
async function pasteText() {
  try { return (await navigator.clipboard.readText()) || ''; } catch { return null; }
}

export class UI {
  constructor(bot, { wake, store, version }) {
    this.bot = bot;
    this.wake = wake;
    this.store = store;
    this.version = version;
    this.tab = 'home';
    this.coinView = 'trending';
    this.tracking = false;
    this.tradesView = 'open';
    this.wiz = { step: 0, key: '', keyTest: null, importing: false, style: 'balanced', backupChecked: false, showKey: false, busy: false };
    this.sheet = null;
    this.busyBuys = new Set();
    this.seenActivity = bot.activity[0]?.t || 0;
    this.a2hsDismissed = !!store.load('a2hsDismissed', false);
  }

  mount() {
    this.app = document.getElementById('app');
    this.sheetRoot = document.getElementById('sheet-root');
    document.getElementById('boot').hidden = true;
    this.app.hidden = false;
    document.addEventListener('click', (e) => this._onClick(e));
    document.addEventListener('change', (e) => this._onChange(e));
    this.bot.addEventListener('change', () => this.scheduleUpdate());
    this.timer = setInterval(() => this.scheduleUpdate(), 1000);
    this.renderAll();
  }

  /** Dollars when the SOL price is known, SOL otherwise. */
  money(sol, { sign = false } = {}) {
    const price = this.bot.solUsd;
    if (price > 0) {
      const usd = sol * price;
      const body = '$' + Math.abs(usd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      if (sign) return (usd >= 0.005 ? '+' : usd <= -0.005 ? '−' : '') + body;
      return (usd <= -0.005 ? '−' : '') + body;
    }
    return (sign ? signed(sol) : solNum(sol)) + ' SOL';
  }

  offerUpdate(version, go) {
    this.updateOffer = { version, go };
    this.scheduleUpdate();
  }

  scheduleUpdate() {
    if (this.updateQueued) return;
    this.updateQueued = true;
    requestAnimationFrame(() => { this.updateQueued = false; this.update(); });
  }

  // ---------- top-level ----------

  renderAll() {
    document.documentElement.dataset.mode = this.bot.settings.mode;
    if (!this.bot.settings.setupDone) { this.renderWizard(); return; }
    this.app.innerHTML = `<main class="screen" id="tab"></main>${this.tabbar()}`;
    this.renderTab();
  }

  update() {
    document.documentElement.dataset.mode = this.bot.settings.mode;
    this._toastNewActivity();
    if (!this.bot.settings.setupDone) return;
    const tb = this.app.querySelector('.tabbar');
    if (tb) { const tmp = document.createElement('div'); tmp.innerHTML = this.tabbar(); patch(tb, tmp.firstElementChild.innerHTML); }
    if (this.tab === 'home') this.renderHome();
    else if (this.tab === 'coins') this.updateCoins();
    else if (this.tab === 'wallets') this.renderWallets();
    else if (this.tab === 'trades') this.renderTrades();
    else if (this.tab === 'settings') this.updateSettingsLive();
    this.updateSheet();
  }

  tabbar() {
    const open = this.bot.positions.size;
    const t = (id, label) => `<button data-action="tab" data-tab="${id}" class="${this.tab === id ? 'on' : ''}" aria-label="${label}">${ICONS[id]}<span>${label}</span>${id === 'trades' && open ? `<span class="count">${open}</span>` : ''}</button>`;
    return `<nav class="tabbar">${t('home', 'Home')}${t('coins', 'Coins')}${t('wallets', 'Wallets')}${t('trades', 'Trades')}${t('settings', 'Settings')}</nav>`;
  }

  renderTab() {
    if (this.tab === 'home') this.renderHome();
    else if (this.tab === 'coins') this.renderCoinsShell();
    else if (this.tab === 'wallets') this.renderWallets();
    else if (this.tab === 'trades') this.renderTrades();
    else this.renderSettings();
  }

  // ---------- Home ----------

  renderHome() {
    const el = document.getElementById('tab');
    if (!el) return;
    const b = this.bot;
    const mode = b.settings.mode;
    const real = mode === 'real';
    const bal = toSol(b.availableLamports(mode));
    const st = b.stats(mode);
    const today = toSol(st.todayLamports);
    const total = toSol(st.totalLamports);
    const openPos = [...b.positions.values()];
    const openPnl = toSol(b.openPnl(mode));
    const alerts = [...b.alerts.values()];
    const statusText = this.powerStatus();
    const feedLive = b.feed?.isLive();
    const pricesOk = b.lastPollAt && Date.now() - b.lastPollAt < 12000;
    const awake = this.wake.held();
    const needAwake = b.running || openPos.length > 0;
    patch(el, `
      <div class="bar">
        <div class="brand">Win Bot<small>pump.fun trading desk · v${esc(this.version)}</small></div>
        <button class="pill mode" data-action="mode-sheet">${real ? 'REAL' : 'PRACTICE'}</button>
      </div>
      ${this.homeBanners()}
      <div class="card balance">
        <div class="spread"><span class="label">${real ? 'Bot wallet' : 'Practice balance'}</span>${real ? `<button class="btn small" data-action="deposit">Add SOL</button>` : `<button class="btn small" data-action="practice-sheet">Add money</button>`}</div>
        <div class="amount money">${b.solUsd ? this.money(bal) : `${solNum(bal)} <small>SOL</small>`}</div>
        <div class="usd">${real && b.balance === null ? 'Checking balance…' : b.solUsd ? solNum(bal) + ' SOL' : 'Loading the SOL price…'}</div>
        <div class="today">
          <span class="chip ${cls(today)}"><span class="num">Today ${this.money(today, { sign: true })}</span></span>
          <span class="chip ${cls(total)}"><span class="num">All time ${this.money(total, { sign: true })}</span></span>
          ${openPos.length ? `<span class="chip ${cls(openPnl)}"><span class="num">Open now ${this.money(openPnl, { sign: true })}</span></span>` : ''}
          <span class="chip">${st.trades} trades · ${st.wins} wins</span>
        </div>
      </div>
      <div class="power-wrap">
        <button class="power ${b.running ? 'on' : ''}" data-action="power" aria-label="${b.running ? 'Stop the bot' : 'Start the bot'}">
          <span class="p-label">${b.running ? 'Stop' : 'Start'}</span>
          <span class="p-sub">${b.running ? 'bot is running' : real ? 'real money' : 'practice'}</span>
        </button>
        <div class="power-status">${statusText}</div>
        ${b.pausedReason ? `<button class="btn small go" data-action="resume">Resume buying</button>` : ''}
      </div>
      ${this.brainCard()}
      <div class="lights">
        <div class="light">Coin feed<div class="row"><span class="dot ${!b.running ? '' : feedLive ? 'ok' : 'warn'}"></span>${!b.running ? 'Off' : feedLive ? 'Live' : 'Connecting'}</div></div>
        <div class="light">Live trades<div class="row"><span class="dot ${b.alerts.has('rpc') ? 'bad' : b.streamStatus === 'live' ? 'ok' : pricesOk ? 'warn' : ''}"></span>${b.alerts.has('rpc') ? 'Problem' : b.streamStatus === 'live' ? 'Live' : pricesOk ? 'Prices only' : 'Idle'}</div></div>
        <button class="light" data-action="keep-awake" style="text-align:left">Screen<div class="row"><span class="dot ${!needAwake ? '' : awake ? 'ok' : 'warn'}"></span>${!needAwake ? 'Normal' : awake ? 'Stays on' : 'Tap: keep on'}</div></button>
      </div>
      ${alerts.map((a) => `<div class="alert ${esc(a.level)}"><span class="ico">${a.level === 'error' ? '⚠️' : a.level === 'warn' ? '⏸' : 'ℹ️'}</span><div class="grow">${esc(a.message)}</div></div>`).join('')}
      ${needAwake ? `<div class="alert"><span class="ico">📱</span><div class="grow"><strong>Keep Win Bot open on screen.</strong> iPhone pauses apps in the background, so the bot only trades while it's open. Plug your phone in; the screen stays on by itself.</div></div>` : ''}
      ${openPos.length ? `<div class="section-title spread"><span>Open trades</span>${openPos.length > 1 ? '<button class="btn ghost small" data-action="sell-all" style="min-height:24px;padding:0;color:var(--red)">Sell all</button>' : ''}</div><div class="list">${openPos.map((p) => this.posRow(p)).join('')}</div>` : ''}
      <div class="section-title spread"><span>Activity</span>${b.activity.length > 4 ? '<button class="btn ghost small" data-action="activity" style="min-height:24px;padding:0">See all</button>' : ''}</div>
      ${this.activityList(4)}
      <p class="small muted center mt2">Memecoins are extremely risky and most go to zero. Only use SOL you can afford to lose. Not financial advice.</p>
    `);
  }

  homeBanners() {
    const out = [];
    if (this.updateOffer) out.push(`<div class="alert ok"><span class="ico">✨</span><div class="grow"><strong>A new version of Win Bot is ready.</strong> It takes a few seconds; open trades are kept.<div class="row mt"><button class="btn small go" data-action="do-update">Update now</button></div></div></div>`);
    if (!this.store.ok) out.push(`<div class="alert error"><span class="ico">⚠️</span><div class="grow">This browser isn't saving data (Private Browsing?). Open Win Bot in normal Safari or from your Home Screen.</div></div>`);
    const funded = (this.bot.balance ?? 0n) > 0n || [...this.bot.positions.values()].some((p) => p.mode === 'real');
    if (isIos() && !isStandalone() && (funded || !this.a2hsDismissed)) {
      out.push(`<div class="alert ${funded ? 'error' : 'warn'}"><span class="ico">📲</span><div class="grow"><strong>${funded ? 'Your bot wallet lives in this Safari tab.' : 'Add Win Bot to your Home Screen.'}</strong> ${funded
        ? 'Safari can clear website data you haven\u2019t opened for 7 days, and the Home Screen app keeps separate data. Make sure your backup key is saved. To move to the Home Screen app, add it, then choose <em>I have a private key to import</em> there.'
        : `Tap ${ICONS.share} Share, then <em>Add to Home Screen</em>. Safari can clear data from websites you haven't opened in 7 days, so your wallet is safer as a Home Screen app.`}
        ${funded ? '' : '<div class="row mt"><button class="btn small" data-action="dismiss-a2hs">Got it</button></div>'}</div></div>`);
    }
    if (this.bot.wasRunning && !this.bot.running) out.push(`<div class="alert"><span class="ico">⏹</span><div class="grow">The bot stopped when the app was closed. Open trades are still being watched. Tap <strong>Start</strong> to look for new coins again.</div></div>`);
    if (this.bot.settings.mode === 'real' && !this.bot.settings.backupDone) out.push(`<div class="alert error"><span class="ico">🔑</span><div class="grow">You haven't confirmed saving your backup key.<div class="row mt"><button class="btn small" data-action="backup">Back up now</button></div></div></div>`);
    return out.join('');
  }

  powerStatus() {
    const b = this.bot;
    if (!b.running) {
      if (b.positions.size) return `Not looking for new coins. <strong>${b.positions.size} open trade${b.positions.size > 1 ? 's' : ''}</strong> still managed.`;
      return b.settings.mode === 'real' ? 'Tap Start to trade with real SOL.' : 'Tap Start to practice with pretend SOL on live coins.';
    }
    if (b.pausedReason) return esc(b.pausedReason);
    if (b.buyInFlight) return '<strong>A coin passed. Checking holders, then buying…</strong>';
    if (b.entryBlock) return esc(b.entryBlock);
    const br = b.brain();
    if (!b.settings.autoBuy) return 'Auto-buy is off: the bot scores coins, you pick on the Coins tab. It still sells for you.';
    if (br.passed.length) return `<strong>${esc(br.passed[0].symbol)}</strong> passed the study. Buying…`;
    if (br.studying.length) return `Studying <strong>${br.studying.length}</strong> coin${br.studying.length === 1 ? '' : 's'}: reading every trade before it buys.`;
    const watching = [...b.coins.values()].filter((c) => c.watching).length;
    if (!b.feed?.isLive() && !watching) return 'Connecting to the live coin feed…';
    return `Scanning <strong>${watching}</strong> new coin${watching === 1 ? '' : 's'} for real buying.`;
  }

  brainCard() {
    const b = this.bot;
    if (!b.running) return '';
    const br = b.brain();
    const p = br.pipeline;
    const rows = [...br.passed, ...br.studying].slice(0, 4).map((c) => this.studyRow(c)).join('');
    return `<div class="card brain mt">
      <div class="spread"><h3>The bot's study desk</h3>${br.pickiness ? `<span class="badge gold">PICKIER +${br.pickiness}</span>` : '<span class="badge">LIVE</span>'}</div>
      <div class="funnel"><div><b>${p.scanned}</b><span>Scanned</span></div><div class="hi"><b>${br.studying.length}</b><span>Studying</span></div><div><b>${p.passed}</b><span>Passed</span></div><div><b>${p.bought}</b><span>Bought</span></div></div>
      ${rows || `<p class="small muted" style="margin:8px 2px 6px">Watching new coins for real buyers and money coming in. Most coins never qualify for a study.</p>`}
      ${br.pickiness ? `<p class="small muted" style="margin:6px 2px 2px">${br.lossStreak} loss${br.lossStreak === 1 ? '' : 'es'} in a row, so coins need ${br.pickiness} more points until the next win.</p>` : ''}
    </div>`;
  }

  studyRow(c) {
    const now = Date.now();
    const v = c.verdict;
    const total = Math.max(1, (c.studyEnd || now) - (c.studyStart || now));
    const left = Math.max(0, Math.ceil(((c.studyEnd || now) - now) / 1000));
    const why = c.stage === 'passed' ? `Passed with ${v?.score ?? '–'}. Buying…` : v ? (v.ok ? `Looking strong · ${left}s left` : `${v.vetoes[0] || v.reason} · ${left}s left`) : `Reading trades · ${left}s left`;
    return `<button class="study-row" data-action="coin" data-mint="${esc(c.mint)}">${scoreRing(v ? v.score : null, v ? (v.ok ? 'pass' : '') : 'fail')}
      <div><div class="nm">${esc(c.symbol)} ${c.isMayhemMode ? '<span class="badge mayhem">MAYHEM</span>' : ''}</div><div class="why">${esc(why)}</div>${c.stage === 'study' ? `<div class="timer"><i style="width:${(clamp01((now - c.studyStart) / total) * 100).toFixed(0)}%"></i></div>` : ''}</div>
      <div class="right small">${this.mcapText(c.lastMcap)}</div></button>`;
  }

  posRow(p) {
    const cost = toSol(p.costLamports);
    const value = p.lastValueLamports !== undefined ? toSol(p.lastValueLamports) : null;
    const pnl = value !== null ? value - cost : null;
    const pp = value !== null && cost > 0 ? (pnl / cost) * 100 : null;
    const state = p.state === 'selling' ? 'Selling…' : p.found ? 'In wallet' : p.lastError && p.sellAttempts ? 'Retrying sale' : 'Held ' + ago(p.openedAt);
    return `<div class="item posrow"><button class="tap-area" data-action="pos" data-id="${esc(p.id)}">${avatar(p.symbol, p.mint)}
      <div class="grow"><div style="font-weight:650">${esc(p.symbol)} <span class="badge ${p.mode}">${p.mode === 'real' ? 'REAL' : 'PRACTICE'}</span>${p.copiedFrom ? ' <span class="badge copy">COPY</span>' : ''}${p.mayhem ? ' <span class="badge mayhem">MAYHEM</span>' : ''}</div><div class="small muted">${esc(state)}</div></div>
      <div class="val"><div class="${cls(pnl ?? 0)}" style="font-weight:700;font-size:17px">${pnl !== null ? this.money(pnl, { sign: true }) : '…'}</div><div class="small ${cls(pnl ?? 0)}">${pp !== null ? pct(pp) : ''}</div></div></button>
      <button class="btn small danger sellbtn" data-action="sell" data-id="${esc(p.id)}" ${p.state === 'selling' ? 'disabled' : ''}>${p.state === 'selling' ? '…' : 'Sell'}</button></div>`;
  }

  activityList(n) {
    const list = this.bot.activity.slice(0, n);
    if (!list.length) return `<div class="list"><div class="empty"><b>Nothing yet</b>Trades and important events show up here.</div></div>`;
    return `<div class="list">${list.map((a) => `<div class="act"><span class="dot ${esc(a.level)}"></span><div class="grow">${esc(a.message)}${a.sig ? ` <a href="https://solscan.io/tx/${esc(a.sig)}" target="_blank" rel="noopener">View</a>` : ''}</div><time>${ago(a.t)}</time></div>`).join('')}</div>`;
  }

  // ---------- Coins ----------

  renderCoinsShell() {
    const el = document.getElementById('tab');
    el.innerHTML = `
      <h1 class="title">Coins</h1>
      <div class="card tight">
        <div class="field"><label for="paste-mint">Buy a coin you found (paste its address)</label>
          <div class="row"><input id="paste-mint" class="input" placeholder="Coin address" autocapitalize="off" autocorrect="off" spellcheck="false" inputmode="text">
          <button class="btn small" data-action="paste-mint">Paste</button></div>
          <button class="btn small mode" data-action="open-pasted" style="width:100%;margin-top:4px">Open coin</button>
        </div>
      </div>
      <div class="row mt" style="margin-bottom:10px"><div class="seg" style="flex:1">
        ${[['trending', 'Trending'], ['movers', 'Movers'], ['mayhem', 'Mayhem'], ['new', 'New']].map(([v, label]) => `<button data-action="coin-view" data-view="${v}" class="${this.coinView === v ? 'on' : ''}">${label}</button>`).join('')}</div></div>
      <div id="coin-head" class="small muted" style="margin:0 4px 8px"></div>
      <div id="coin-list"></div>`;
    this.updateCoins();
  }

  updateCoins() {
    const list = document.getElementById('coin-list');
    if (!list) return;
    const b = this.bot;
    const now = Date.now();
    const view = this.coinView;
    let coins = [...b.coins.values()];
    const snapAgo = (c, ms) => { const s = c.snaps; const last = s[s.length - 1]; let ref = s[0]; for (const x of s) { if (x.t <= last.t - ms) ref = x; else break; } return ref; };
    const rise = (c) => { if (!c.snaps || c.snaps.length < 2) return 0; const ref = snapAgo(c, 60000); const last = c.snaps[c.snaps.length - 1]; return ref.mcap > 0 ? (last.mcap / ref.mcap - 1) * 100 : 0; };
    const inflow = (c) => (c.snaps && c.snaps.length >= 2 ? (c.snaps[c.snaps.length - 1].sol || 0) - (snapAgo(c, 60000).sol || 0) : 0);
    const mayhem = (c) => !!(c.isMayhemMode || c.curve?.isMayhemMode);
    const order = { passed: 0, study: 1, bought: 2, rejected: 3 };
    const byStage = (a, c) => (order[a.stage] ?? 4) - (order[c.stage] ?? 4);
    const change = (c, ms) => { if (!c.snaps || c.snaps.length < 2) return 0; const ref = snapAgo(c, ms); const last = c.snaps[c.snaps.length - 1]; return ref.mcap > 0 ? (last.mcap / ref.mcap - 1) * 100 : 0; };
    // trading activity over 5 minutes: every bit of SOL that moved in or out of the curve
    const activity = (c) => { let a = 0; const s = c.snaps || []; const from = s.length ? s[s.length - 1].t - 300000 : 0; for (let i = 1; i < s.length; i++) if (s[i].t >= from) a += Math.abs((s[i].sol || 0) - (s[i - 1].sol || 0)); return a; };
    if (view === 'trending') {
      // where the money is going: coins the bot is studying first, then the most SOL coming in
      coins = coins.filter((c) => !mayhem(c) && (c.verdict || c.stage === 'study' || c.stage === 'passed' || (c.watching && inflow(c) > 0.2)))
        .sort((a, c) => byStage(a, c) || inflow(c) - inflow(a));
    } else if (view === 'movers') {
      // like pump.fun's Movers: the biggest price gains right now, among coins people are actually trading
      coins = coins.filter((c) => !mayhem(c) && c.snaps.length >= 3 && activity(c) >= 0.5 && change(c, 300000) > 0).sort((a, c) => change(c, 300000) - change(a, 300000));
    } else if (view === 'mayhem') {
      coins = coins.filter(mayhem).sort((a, c) => byStage(a, c) || rise(c) - rise(a) || c.createdAt - a.createdAt);
    } else {
      coins.sort((a, c) => c.createdAt - a.createdAt);
    }
    coins = coins.slice(0, 60);
    const head = document.getElementById('coin-head');
    const br = b.brain();
    const live = b.feed?.isLive() ? 'live' : 'connecting…';
    if (head) {
      head.textContent = !b.running ? 'Start the bot on Home to see coins launching live.'
        : view === 'movers' ? `Biggest gains in the last 5 minutes · ${live}`
        : view === 'mayhem' ? `Mayhem coins only · the bot buys one only when it's flying up · ${live}`
        : `${br.pipeline.scanned} scanned · ${br.studying.length} studying · ${br.pipeline.passed} passed · ${live}`;
    }
    if (!coins.length) {
      const empty = {
        trending: ['Nothing trending yet', 'Coins with real buyers and money coming in show up here, with the bot\u2019s score once it studies them.'],
        movers: ['No movers yet', 'Coins with the biggest price gains in the last 5 minutes (with real trading) show up here.'],
        mayhem: ['No mayhem coins yet', 'Mayhem coins (pump.fun\u2019s trading agent buys and sells them) show up here. The bot only buys one when the study says it\u2019s flying up.'],
        new: ['Waiting for coins…', 'New pump.fun coins appear here within seconds.'],
      }[view] || ['Waiting for coins…', ''];
      patch(list, `<div class="list"><div class="empty"><b>${!b.running ? 'The coin feed is off' : empty[0]}</b>${!b.running ? 'Tap Start on the Home tab. You can still paste a coin address above.' : empty[1]}</div></div>`);
      return;
    }
    const movers = view === 'movers';
    patch(list, `<div class="list">${coins.map((c) => this.coinRow(c, movers ? change(c, 300000) : rise(c), now, movers ? '5m' : '1m', view === 'mayhem')).join('')}</div>`);
  }

  coinRow(c, r, now, span = '1m', hideMayhemBadge = false) {
    const held = this.bot.positions.has(this.bot.settings.mode + ':' + c.mint);
    const prog = Math.round((c.lastProgress || 0) * 100);
    const v = c.verdict;
    const stage = held ? ['bought', 'Holding'] : c.stage === 'study' ? ['study', 'Studying'] : c.stage === 'passed' ? ['pass', 'Passed'] : c.stage === 'bought' ? ['bought', 'Bought'] : c.stage === 'rejected' ? ['reject', 'Rejected'] : null;
    let status = held ? 'You hold this coin' : c.status || (c.scan && !c.scan.ok ? c.scan.reason : '') || (c.snaps.length ? '' : 'Loading price…');
    if (c.stage === 'study' && v) status = v.ok ? `Looking strong: score ${v.score}, needs ${v.need}` : v.vetoes[0];
    const tone = held || c.stage === 'passed' || c.stage === 'bought' ? 'good' : c.stage === 'study' ? 'gold' : '';
    return `<button class="coin" data-action="coin" data-mint="${esc(c.mint)}">${v ? scoreRing(v.score, v.ok ? 'pass' : c.stage === 'study' ? '' : 'fail') : avatar(c.symbol, c.mint)}
      <div class="name">${esc(c.name)}<small>${esc(c.symbol)}</small></div>
      <div class="side">${sparkline(c.snaps)}<div class="right">${this.mcapText(c.lastMcap)}</div></div>
      <div class="meta">${stage ? `<span class="stage ${stage[0]}">${stage[1]}</span>` : ''}${c.isMayhemMode && !hideMayhemBadge ? '<span class="badge mayhem">MAYHEM</span>' : ''}<span>${ago(c.createdAt, now)}</span><span class="rail"><i style="width:${prog}%"></i></span><span class="change ${cls(r)}">${c.snaps.length >= 2 ? pct(r) + ' ' + span : ''}</span></div>
      ${status ? `<div class="status ${tone}">${esc(status)}</div>` : ''}</button>`;
  }

  mcapText(sol) {
    if (!sol) return '–';
    if (this.bot.solUsd) {
      const usd = sol * this.bot.solUsd;
      return '$' + (usd >= 1e6 ? (usd / 1e6).toFixed(2) + 'M' : usd >= 1e3 ? (usd / 1e3).toFixed(1) + 'K' : usd.toFixed(0));
    }
    return sol.toFixed(1) + ' SOL';
  }

  // ---------- Wallets ----------

  renderWallets() {
    const el = document.getElementById('tab');
    if (!el) return;
    const b = this.bot;
    const list = b.wallets;
    patch(el, `<h1 class="title">Wallets</h1>
      <div class="card tight">
        <div class="field"><label for="track-input">Track a trader: paste their wallet address, pump.fun profile link, or @username</label>
          <div class="row"><input id="track-input" class="input" placeholder="Address or @username" autocapitalize="off" autocorrect="off" spellcheck="false">
          <button class="btn small" data-action="paste" data-target="track-input">Paste</button></div>
          <button class="btn go" data-action="track" style="margin-top:6px;min-height:46px" ${this.tracking ? 'disabled' : ''}>${this.tracking ? 'Looking them up…' : 'Track wallet'}</button>
        </div>
      </div>
      ${list.length ? list.map((w) => this.walletCard(w)).join('') : `<div class="list mt"><div class="empty"><b>No wallets yet</b>Add a trader you like. You'll see their pump.fun buys and sells live, and you can copy them.</div></div>`}
      <p class="small muted center mt2">Copy trading buys the same coin the moment they buy (with your amount), on pump.fun or PumpSwap, and sells the moment they sell, the same share they sold. Your stop loss still protects you. It copies whenever Win Bot is open on screen, even if the bot isn't started.</p>`);
  }

  walletCard(w) {
    const b = this.bot;
    const name = b.walletLabel(w.address);
    const trades = w.trades.slice(0, 6);
    const now = Date.now();
    const open = [...b.positions.values()].filter((p) => p.copiedFrom === w.address).length;
    return `<div class="card wallet">
      <div class="head">${avatar(name.replace(/^@/, ''), w.address)}<div class="grow" style="flex:1"><div class="who">${esc(name)}</div><div class="addr">${w.username || w.label ? esc(short(w.address)) + ' · ' : ''}${w.balance !== null && w.balance !== undefined ? solNum(toSol(w.balance)) + ' SOL' : 'Loading…'}</div></div>
        <button class="btn small" data-action="wallet-refresh" data-address="${esc(w.address)}" ${w.loading ? 'disabled' : ''}>${w.loading ? '…' : 'Refresh'}</button></div>
      <div class="copybox ${w.copy ? 'on' : ''}">
        <label class="row" style="gap:12px"><div class="grow" style="flex:1"><div style="font-weight:650">Copy their trades</div><div class="small muted">${w.copy ? `Buys ${w.copySol} SOL of each coin they buy${open ? ` · ${open} open` : ''}` : 'Off: just watching'}</div></div>
          <span class="switch"><input type="checkbox" data-wallet-copy="${esc(w.address)}" ${w.copy ? 'checked' : ''}><span></span></span></label>
        ${w.copy ? `<div class="row"><span class="small" style="flex:1">SOL per copied trade</span><div class="stepper"><input data-wallet-sol="${esc(w.address)}" inputmode="decimal" value="${esc(w.copySol)}" aria-label="SOL per copied trade"><span class="small muted">SOL</span></div></div>` : ''}
      </div>
      <div class="wtrades">${trades.length ? trades.map((t) => `<button class="wtrade" style="background:none;border:0;text-align:left;width:100%" ${t.mint ? `data-action="coin" data-mint="${esc(t.mint)}"` : ''}><span class="side ${t.buy ? 'b' : 's'}">${t.buy ? 'BUY' : 'SELL'}</span><div><div>${esc(t.symbol || (t.mint ? short(t.mint) : 'Coin'))}${t.pool ? ' <span class="badge">PUMPSWAP</span>' : ''} · ${this.bot.solUsd ? this.money(t.sol) : solNum(t.sol) + ' SOL'}</div>${t.note ? `<div class="note ${/^Copied|^Copying/.test(t.note) ? 'gold' : ''}">${esc(t.note)}</div>` : ''}</div><time>${ago(t.t, now)}</time></button>`).join('')
        : `<p class="small muted" style="margin:6px 2px">${w.loading ? 'Loading their recent trades…' : 'No pump.fun trades seen yet. New ones show up here live.'}</p>`}</div>
      <div class="row mt"><a class="btn small" style="flex:1" href="https://pump.fun/profile/${esc(w.address)}" target="_blank" rel="noopener">pump.fun profile</a><button class="btn small danger" style="flex:1" data-action="wallet-remove" data-address="${esc(w.address)}">Remove</button></div>
    </div>`;
  }

  // ---------- Trades ----------

  renderTrades() {
    const el = document.getElementById('tab');
    if (!el) return;
    const b = this.bot;
    const open = [...b.positions.values()];
    const mode = b.settings.mode;
    let body;
    if (this.tradesView === 'open') {
      const openPnl = toSol(b.openPnl(mode));
      body = open.length ? (`<div class="card tight spread" style="margin-bottom:10px"><span class="muted">Up or down right now</span><b class="${cls(openPnl)}" style="font-size:19px">${this.money(openPnl, { sign: true })}</b></div>`) + open.map((p) => this.posCard(p)).join('') + (open.length > 1 ? `<button class="btn danger mt" data-action="sell-all">Sell everything now</button>` : '')
        : `<div class="list"><div class="empty"><b>No open trades</b>${b.running ? 'The bot buys when a coin passes its rules.' : 'Start the bot on Home, or buy a coin from the Coins tab.'}</div></div>`;
    } else {
      const st = b.stats(mode);
      const rate = st.trades ? Math.round((st.wins / st.trades) * 100) + '%' : '–';
      const hist = b.history.filter((h) => h.mode === mode).slice(0, 100);
      body = `<div class="stats"><div class="stat"><b class="${cls(toSol(st.totalLamports))}">${this.money(toSol(st.totalLamports), { sign: true })}</b><span>Total ${this.bot.solUsd ? '' : 'SOL'}</span></div><div class="stat"><b>${rate}</b><span>Win rate</span></div><div class="stat"><b>${st.trades}</b><span>Trades</span></div></div>
        <div class="section-title">${mode === 'real' ? 'Real' : 'Practice'} trades</div>
        ${hist.length ? `<div class="list">${hist.map((h) => this.histRow(h)).join('')}</div>` : `<div class="list"><div class="empty"><b>No finished trades yet</b>Sold trades show here with their result.</div></div>`}`;
    }
    patch(el, `<h1 class="title">Trades</h1>
      <div class="seg" style="margin-bottom:14px"><button data-action="trades-view" data-view="open" class="${this.tradesView === 'open' ? 'on' : ''}">Open (${open.length})</button><button data-action="trades-view" data-view="history" class="${this.tradesView === 'history' ? 'on' : ''}">History</button></div>
      ${body}`);
  }

  posCard(p) {
    const rules = this.bot.rules();
    const cost = toSol(p.costLamports);
    const value = p.lastValueLamports !== undefined ? toSol(p.lastValueLamports) : null;
    const pnl = value !== null ? value - cost : null;
    const pp = value !== null && cost > 0 ? (pnl / cost) * 100 : null;
    let state;
    if (p.state === 'selling') state = `Selling now (${esc(p.sellReason || '')})…`;
    else if (p.found) state = "Found in the bot wallet. The bot won't sell it unless you tap Sell.";
    else if (p.lastError && p.sellAttempts) state = `Retrying the sale: ${esc(p.lastError)}`;
    else if (!p.managed) state = 'Not managed by the bot';
    else if (p.copiedFrom) state = `Copying ${esc(this.bot.walletLabel(p.copiedFrom))}: sells when they sell. Stop loss ${pct(-rules.stopLossPct)}.`;
    else if (p.mayhem && this.bot.solUsd) state = `Mayhem coin: takes $${rules.mayhemProfitMinUsd}–$${rules.mayhemProfitMaxUsd} profit (more while it's flying), stop loss ${pct(-rules.stopLossPct)}.`;
    else state = `Sells at ${pct(rules.takeProfitPct)} or ${pct(-rules.stopLossPct)}, when sellers take over, or after ${rules.maxHoldMin} min.`;
    return `<div class="card pos">
      <div class="top">${avatar(p.symbol, p.mint)}<div class="grow" style="flex:1"><div style="font-weight:700">${esc(p.name)}</div><div class="small muted">${esc(p.symbol)} · <span class="badge ${p.mode}">${p.mode === 'real' ? 'REAL' : 'PRACTICE'}</span>${p.copiedFrom ? ' <span class="badge copy">COPY</span>' : ''}${p.mayhem ? ' <span class="badge mayhem">MAYHEM</span>' : ''}${p.score !== null && p.score !== undefined ? ` <span class="badge gold">SCORE ${esc(p.score)}</span>` : ''}</div></div>
      <div class="pnl ${cls(pnl ?? 0)}">${pnl !== null ? this.money(pnl, { sign: true }) : '…'}<small>${pp !== null ? pct(pp) + ' · ' + signed(pnl) + ' SOL' : 'pricing…'}</small></div></div>
      <div class="facts"><div class="fact"><b>${this.money(cost)}</b><span>Paid</span></div><div class="fact"><b>${value !== null ? this.money(value) : '–'}</b><span>Worth now</span></div><div class="fact"><b>${p.onPool ? 'PumpSwap' : p.complete ? 'Graduated' : Math.round((p.progress || 0) * 100) + '%'}</b><span>${p.onPool ? 'Market' : 'Curve'}</span></div></div>
      <div class="state">${state}</div>
      ${this.sellButtons(p)}
      <div class="actions"><a class="btn small" style="flex:1" href="https://pump.fun/coin/${esc(p.mint)}" target="_blank" rel="noopener">Chart</a>${p.buySig ? `<a class="btn small" style="flex:1" href="https://solscan.io/tx/${esc(p.buySig)}" target="_blank" rel="noopener">Solscan</a>` : ''}</div></div>`;
  }

  sellButtons(p) {
    const off = p.state === 'selling' ? 'disabled' : '';
    if (p.state === 'selling') return `<div class="sellrow"><button class="btn danger small" disabled>Selling…</button></div>`;
    return `<div class="sellrow"><button class="btn danger small" data-action="sell-part" data-id="${esc(p.id)}" data-fraction="0.25" ${off}>Sell 25%</button><button class="btn danger small" data-action="sell-part" data-id="${esc(p.id)}" data-fraction="0.5" ${off}>Sell 50%</button><button class="btn danger small strong" data-action="sell" data-id="${esc(p.id)}" ${off}>Sell all</button></div>`;
  }

  histRow(h) {
    const pnl = h.pnlLamports === null ? null : toSol(h.pnlLamports);
    const cost = toSol(h.costLamports);
    const pp = pnl !== null && cost > 0 ? (pnl / cost) * 100 : null;
    return `<button class="item" data-action="hist" data-id="${esc(h.id)}">${avatar(h.symbol, h.mint)}
      <div class="grow"><div style="font-weight:650">${esc(h.symbol)}${h.partial ? ' <span class="badge">PART</span>' : ''}${h.copiedFrom ? ' <span class="badge copy">COPY</span>' : ''}</div><div class="small muted">${esc(h.reason)} · ${agoText(h.closedAt)}</div></div>
      <div class="val"><div class="${cls(pnl ?? 0)}" style="font-weight:700">${pnl !== null ? this.money(pnl, { sign: true }) : '?'}</div><div class="small ${cls(pnl ?? 0)}">${pp !== null ? pct(pp) : 'unknown'}</div></div></button>`;
  }

  // ---------- Settings ----------

  renderSettings() {
    const el = document.getElementById('tab');
    const b = this.bot;
    const s = b.settings;
    const rules = b.rules();
    const real = s.mode === 'real';
    const num = (key, label, unit, step) => {
      const v = s[key] ?? rules[key];
      return `<div class="item"><div class="grow">${label}</div><div class="stepper"><input data-num="${key}" inputmode="decimal" value="${esc(v)}" aria-label="${label}" step="${step}"><span class="small muted" style="width:34px">${unit}</span></div></div>`;
    };
    const sw = (key, label, sub) => `<label class="item"><div class="grow">${label}${sub ? `<div class="small muted">${sub}</div>` : ''}</div><span class="switch"><input type="checkbox" data-setting="${key}" ${s[key] !== false ? 'checked' : ''}><span></span></span></label>`;
    el.innerHTML = `
      <h1 class="title">Settings</h1>
      <div class="section-title">Trading</div>
      <div class="list">
        <button class="item" data-action="mode-sheet"><div class="grow">Mode</div><div class="val">${real ? 'Real money' : 'Practice'}</div><span class="chev">›</span></button>
        <div class="item" style="display:block"><div style="margin-bottom:8px">Style</div><div class="seg">${Object.entries(STYLES).map(([k, v]) => `<button data-action="set" data-key="style" data-value="${k}" class="${s.style === k ? 'on' : ''}">${v.label}</button>`).join('')}</div><div class="small muted" style="margin-top:8px">${esc(STYLES[s.style]?.blurb || '')}</div></div>
        ${sw('autoBuy', 'Bot buys by itself', 'Off = you choose coins, the bot still sells them for you')}
        <div class="item" style="display:block"><div style="margin-bottom:8px">Speed <span class="small muted">(higher = faster trades, bigger network fee)</span></div><div class="seg">${Object.entries(SPEEDS).map(([k, v]) => `<button data-action="set" data-key="speed" data-value="${k}" class="${s.speed === k ? 'on' : ''}">${v.label}</button>`).join('')}</div></div>
      </div>
      <div class="section-title">Rules (${esc(STYLES[s.style]?.label)} defaults unless you change them)</div>
      <div class="list">
        ${num('tradeSol', 'SOL per trade', 'SOL', 0.01)}
        ${num('maxOpen', 'Most trades at once', '', 1)}
        ${num('takeProfitPct', 'Take profit at', '%', 5)}
        ${num('stopLossPct', 'Stop loss at', '−%', 5)}
        ${num('trailStartPct', 'Trailing stop starts at', '%', 5)}
        ${num('trailDropPct', 'Trailing stop drop', '%', 1)}
        ${num('maxHoldMin', 'Sell after', 'min', 1)}
        ${num('dailyLossSol', 'Stop buying after losing', 'SOL', 0.05)}
        ${sw('sellBeforeGraduation', 'Sell before a coin graduates', 'Sells at 95% of the curve')}
        <button class="item" data-action="reset-rules"><div class="grow" style="color:var(--blue)">Use the style's defaults</div></button>
      </div>
      <div class="section-title">How it studies coins</div>
      <div class="list">
        ${num('studySec', 'Study each coin for', 'sec', 5)}
        <label class="item"><div class="grow">Trade mayhem coins<div class="small muted">Only when the study says it's flying up</div></div><span class="switch"><input type="checkbox" data-setting-inverse="skipMayhem" ${s.skipMayhem === true ? '' : 'checked'}><span></span></span></label>
        ${num('mayhemStudySec', 'Study mayhem coins for', 'sec', 5)}
        ${num('mayhemProfitMinUsd', 'Mayhem: take profit at', '$', 1)}
        ${num('mayhemProfitMaxUsd', 'Mayhem: up to, if flying', '$', 1)}
      </div>
      <div class="section-title">Bot wallet</div>
      <div class="list">
        <button class="item" data-action="copy-address"><div class="grow">Address<div class="small muted mono" id="set-address">${esc(b.wallet?.address || 'No wallet yet')}</div></div><span class="small" style="color:var(--blue)">Copy</span></button>
        <div class="item"><div class="grow">Balance</div><div class="val money" id="set-balance"></div></div>
        <button class="item" data-action="deposit"><div class="grow">Add SOL</div><span class="chev">›</span></button>
        <button class="item" data-action="withdraw"><div class="grow">Send SOL to Phantom</div><span class="chev">›</span></button>
        <button class="item" data-action="backup"><div class="grow">Show backup key</div><span class="chev">›</span></button>
        <button class="item" data-action="import"><div class="grow">Use a different wallet</div><span class="chev">›</span></button>
      </div>
      <div class="section-title">Practice</div>
      <div class="list">
        <div class="item"><div class="grow">Practice balance</div><div class="val money" id="set-practice"></div></div>
        <button class="item" data-action="practice-sheet"><div class="grow">Add practice money</div><span class="chev">›</span></button>
        <button class="item" data-action="reset-practice"><div class="grow" style="color:var(--blue)">Reset practice to ${s.practiceStartSol} SOL</div></button>
      </div>
      <div class="section-title">Connection</div>
      <div class="list">
        <button class="item" data-action="edit-key"><div class="grow">Data key (Helius)<div class="small muted" id="set-key"></div></div><span class="chev">›</span></button>
        <div class="item"><div class="grow">Solana</div><div class="val" id="set-rpc"></div></div>
        <div class="item"><div class="grow">Coin feed</div><div class="val" id="set-feed"></div></div>
        <div class="item"><div class="grow">PumpPortal backup route</div><div class="val" id="set-pp"></div></div>
      </div>
      <div class="section-title">Help</div>
      <div class="list">
        <button class="item" data-action="help"><div class="grow">How the bot works</div><span class="chev">›</span></button>
        <button class="item" data-action="activity"><div class="grow">Full activity list</div><span class="chev">›</span></button>
      </div>
      <div class="list mt2"><button class="item" data-action="erase"><div class="grow" style="color:var(--red)">Erase everything on this phone</div></button></div>
      <p class="small muted center mt2">Win Bot ${esc(this.version)} · Your keys never leave this phone.<br>Memecoins are extremely risky. Not financial advice.</p>`;
    this.updateSettingsLive();
  }

  updateSettingsLive() {
    const b = this.bot;
    const set = (id, html) => { const e = document.getElementById(id); if (e && e.innerHTML !== html) e.innerHTML = html; };
    set('set-balance', b.balance === null ? '–' : solNum(toSol(b.balance)) + ' SOL');
    set('set-practice', solNum(toSol(b.practice.balance)) + ' SOL' + (b.solUsd ? ` <span class="small">($${(toSol(b.practice.balance) * b.solUsd).toLocaleString('en-US', { maximumFractionDigits: 0 })})</span>` : ''));
    const key = b.settings.rpcInput || '';
    set('set-key', key ? esc(b.rpcInfo ? b.rpcInfo.label + ' · ' + (key.length > 10 ? '••••' + key.slice(-4) : '••••') : "Not valid. Tap to fix.") : 'Not set');
    set('set-rpc', !b.rpc ? 'Not set' : b.alerts.has('rpc') ? '<span class="down">Problem</span>' : b.rpc.lastOkAt ? '<span class="up">Connected</span>' : 'Ready');
    const f = b.feedStatus;
    set('set-feed', !b.running ? 'Off' : `${f.chain === 'live' ? '<span class="up">Solana live</span>' : 'Solana ' + esc(f.chain)} · ${f.pumpportal === 'live' ? '<span class="up">PumpPortal live</span>' : 'PumpPortal ' + esc(f.pumpportal)}`);
    const pp = b.trader?.pumpPortalWorks;
    set('set-pp', pp === true ? '<span class="up">Works</span>' : pp === false ? '<span class="down">Blocked on this phone</span>' : 'Not needed yet');
  }

  // ---------- Wizard ----------

  renderWizard() {
    const w = this.wiz;
    const b = this.bot;
    const steps = 5;
    const dots = Array.from({ length: steps }, (_, i) => `<i class="${i <= w.step ? 'on' : ''}"></i>`).join('');
    let body = '', foot = '';
    if (w.step === 0) {
      body = `<div class="hero"><div class="logo" role="img" aria-label="Win Bot"></div><h1>Win Bot</h1><p>A pump.fun trading bot that studies every coin before it buys.</p></div>
        <div class="points">
          <div class="point"><span class="n">1</span><p><strong>Practice first</strong>It starts with pretend SOL on real live coins, so you can watch it work.</p></div>
          <div class="point"><span class="n">2</span><p><strong>It studies before it buys</strong>It reads every trade on a promising coin for 10 seconds, on top of everything it saw before: real buyers, money coming in, whales, and whether the creator is selling. Most coins fail. Only strong ones get bought.</p></div>
          <div class="point"><span class="n">3</span><p><strong>Your keys stay on this phone</strong>The bot has its own wallet. Nothing is sent to any server of ours.</p></div>
        </div>
        ${isIos() && !isStandalone() ? `<div class="alert warn mt"><span class="ico">📲</span><div class="grow"><strong>First, add it to your Home Screen.</strong> Tap ${ICONS.share} Share at the bottom of Safari, then <em>Add to Home Screen</em>, then open Win Bot from your Home Screen and set it up there. The Home Screen app keeps its own data, so a wallet made here in Safari won't show up there.</div></div>` : ''}`;
      foot = isIos() && !isStandalone()
        ? `<button class="btn ghost" data-action="wiz-next">Set up here in Safari anyway</button>`
        : `<button class="btn go" data-action="wiz-next">Get started</button>`;
    } else if (w.step === 1) {
      const t = w.keyTest;
      body = `<h1 class="title small">Connect to Solana</h1><p class="sub" style="margin-top:0">The bot reads live prices through a free Helius key. It takes about 2 minutes.</p>
        <div class="points" style="margin-top:0">
          <div class="point"><span class="n">1</span><p><strong>Open Helius and sign up free</strong><a href="${HELIUS_SIGNUP}" target="_blank" rel="noopener">dashboard.helius.dev</a>, sign in with Google or email. Pick the Free plan.</p></div>
          <div class="point"><span class="n">2</span><p><strong>Copy your API key</strong>It's on the dashboard home (looks like <span class="mono">1a2b3c4d-…</span>).</p></div>
          <div class="point"><span class="n">3</span><p><strong>Paste it here</strong></p></div>
        </div>
        <div class="field mt"><div class="row"><input id="wiz-key" class="input" placeholder="Helius API key" value="${esc(w.key)}" autocapitalize="off" autocorrect="off" spellcheck="false"><button class="btn small" data-action="wiz-paste-key">Paste</button></div></div>
        ${t ? `<div class="alert ${t.ok ? 'ok' : 'error'}"><span class="ico">${t.ok ? '✅' : '⚠️'}</span><div class="grow">${esc(t.message)}</div></div>` : ''}`;
      foot = t?.ok ? `<button class="btn go" data-action="wiz-next">Continue</button>` : `<button class="btn primary" data-action="wiz-test-key" ${w.busy ? 'disabled' : ''}>${w.busy ? 'Testing…' : 'Test key'}</button>`;
      foot += `<button class="btn ghost" data-action="wiz-back">Back</button>`;
    } else if (w.step === 2) {
      body = `<h1 class="title small">Your bot wallet</h1><p class="sub" style="margin-top:0">The bot trades from its own wallet that lives on this phone. You move SOL in and out from Phantom.</p>
        <div class="alert warn"><span class="ico">⚠️</span><div class="grow">Don't use your main wallet. Give the bot a separate wallet with only what you're willing to trade.</div></div>
        <p class="small muted">Set Win Bot up before (for example in Safari)? Choose <strong>I have a private key to import</strong> and paste that wallet's backup key.</p>
        ${w.importing ? `<div class="field mt"><label for="wiz-import">Private key (from Phantom: Settings → your account → Show Private Key)</label><textarea id="wiz-import" class="input" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Paste a private key"></textarea></div>
          <div class="btn-row mt"><button class="btn" data-action="wiz-paste-import">Paste</button><button class="btn primary" data-action="wiz-import">Import</button></div>` : ''}`;
      foot = w.importing ? `<button class="btn ghost" data-action="wiz-import-toggle">Create a new wallet instead</button>`
        : `<button class="btn go" data-action="wiz-create" ${w.busy ? 'disabled' : ''}>Create a new wallet</button><button class="btn" data-action="wiz-import-toggle">I have a private key to import</button>`;
      foot += `<button class="btn ghost" data-action="wiz-back">Back</button>`;
    } else if (w.step === 3) {
      const secret = b.exportSecret() || '';
      body = `<h1 class="title small">Save your backup key</h1><p class="sub" style="margin-top:0">This key <strong>is</strong> the wallet. If you delete the app or lose your phone, it's the only way to get your SOL back.</p>
        <div class="secret ${w.showKey ? '' : 'hidden-key'}"><div class="mono">${esc(secret)}</div></div>
        <div class="btn-row mt"><button class="btn" data-action="wiz-show-key">${w.showKey ? 'Hide' : 'Show key'}</button><button class="btn" data-action="copy-secret">Copy key</button></div>
        <div class="alert mt"><span class="ico">💡</span><div class="grow">Paste it into your password manager or a locked note. Anyone with this key can take the bot wallet's SOL, so never send it to anyone. You can also import it into Phantom to see the wallet there.</div></div>
        <label class="check mt"><input type="checkbox" id="wiz-backup" ${w.backupChecked ? 'checked' : ''}><span>I saved my backup key somewhere safe.</span></label>`;
      foot = `<button class="btn go" data-action="wiz-backup-done" ${w.backupChecked ? '' : 'disabled'}>Continue</button>`;
    } else if (w.step === 4) {
      body = `<h1 class="title small">Pick a style</h1><p class="sub" style="margin-top:0">You can change it any time in Settings.</p>
        <div class="stack">${Object.entries(STYLES).map(([k, v]) => `<button class="style-card ${w.style === k ? 'on' : ''}" data-action="wiz-style" data-style="${k}">
          <div class="spread"><strong>${v.label}</strong>${k === 'balanced' ? '<span class="badge real">START HERE</span>' : ''}</div><p>${esc(v.blurb)}</p>
          <div class="nums"><span>${v.tradeSol} SOL a trade</span><span>Score ${v.entry.minScore}+ to buy</span><span>Take profit +${v.takeProfitPct}%</span><span>Stop loss −${v.stopLossPct}%</span></div></button>`).join('')}</div>`;
      foot = `<button class="btn go" data-action="wiz-finish">Finish (starts in Practice)</button><button class="btn ghost" data-action="wiz-back">Back</button>`;
    }
    this.app.innerHTML = `<div class="screen no-tabs wiz"><div class="steps">${dots}</div><div class="body">${body}</div><div class="foot">${foot}</div></div>`;
  }

  // ---------- sheets ----------

  openSheet(kind, data = {}) {
    this.sheet = { kind, data };
    this.sheetRoot.innerHTML = `<div class="backdrop" data-action="close-sheet"></div><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div><div id="sheet-body"></div></div>`;
    this.sheetRendered = null;
    this.renderSheet();
    if (kind === 'coin' && !this.bot.coins.has(data.mint)) this.lookupCoin(data.mint);
  }

  closeSheet() {
    this.sheet = null;
    this.sheetRendered = null;
    this.sheetRoot.innerHTML = '';
  }

  updateSheet() {
    if (!this.sheet) return;
    if (['coin', 'pos', 'activity', 'deposit', 'practice'].includes(this.sheet.kind)) this.renderSheet();
  }

  renderSheet() {
    const body = document.getElementById('sheet-body');
    if (!body || !this.sheet) return;
    const { kind, data } = this.sheet;
    const b = this.bot;
    const close = `<button class="btn ghost mt" data-action="close-sheet">Close</button>`;
    let html = '';
    if (kind === 'coin') {
      const c = b.coins.get(data.mint);
      const name = c?.name || data.name || 'Coin';
      const symbol = c?.symbol || data.symbol || short(data.mint);
      const mcap = c?.lastMcap ?? data.mcap;
      const progress = c?.lastProgress ?? data.progress;
      const mode = b.settings.mode;
      const amounts = [...new Set([b.rules().tradeSol, 0.02, 0.05, 0.1])].sort((x, y) => x - y).slice(0, 4);
      const holders = c?.holders;
      html = `<div class="row">${avatar(symbol, data.mint)}<div><h2>${esc(name)}</h2><div class="muted">${esc(symbol)} · <span class="mono">${esc(short(data.mint))}</span></div></div></div>
        <dl class="kv mt">
          <dt>Market cap</dt><dd>${mcap ? this.mcapText(mcap) + (b.solUsd ? ` (${mcap.toFixed(1)} SOL)` : '') : data.error ? '–' : 'Loading…'}</dd>
          <dt>Curve progress</dt><dd>${data.complete ? 'Graduated' : progress !== undefined ? Math.round(progress * 100) + '%' : '–'}</dd>
          ${c ? `<dt>Age</dt><dd>${ago(c.createdAt)}</dd>` : ''}
          ${c?.solRaised !== undefined ? `<dt>SOL put in</dt><dd>${c.solRaised.toFixed(2)} SOL</dd>` : ''}
          ${c?.vsLaunch ? `<dt>vs launch price</dt><dd class="${c.vsLaunch >= 1 ? 'up' : 'down'}">${c.vsLaunch.toFixed(2)}×</dd>` : ''}
          ${c?.isMayhemMode ? '<dt>Type</dt><dd><span class="badge mayhem">MAYHEM</span></dd>' : ''}
          ${!c?.verdict ? `<dt>Bot's view</dt><dd>${esc(data.error || c?.status || (c?.scan ? c.scan.reason : data.complete ? 'Graduated coins can be sold here, not bought' : 'Not studied'))}</dd>` : ''}
          ${holders ? `<dt>Holders</dt><dd class="${holders.ok ? 'up' : 'down'}">${esc(holders.reason)}</dd>` : ''}
        </dl>
        ${(() => { const hp = b.positions.get(mode + ':' + data.mint); if (!hp) return ''; const v = hp.lastValueLamports !== undefined ? toSol(hp.lastValueLamports) : null; const pl = v !== null ? v - toSol(hp.costLamports) : null; return `<div class="section-title">You hold this coin</div><div class="card tight"><div class="spread"><span class="muted">Up or down</span><b class="${cls(pl ?? 0)}">${pl !== null ? this.money(pl, { sign: true }) : '…'}</b></div>${this.sellButtons(hp)}</div>`; })()}
        ${c?.verdict ? this.studyReport(c) : ''}
        <div class="section-title">Buy with ${mode === 'real' ? 'real SOL' : 'practice SOL'}</div>
        <div class="btn-row ${amounts.length === 3 ? 'three' : ''}" style="grid-template-columns:repeat(${amounts.length},1fr)">${amounts.map((a) => `<button class="btn mode" data-action="buy" data-mint="${esc(data.mint)}" data-sol="${a}" ${this.busyBuys.has(data.mint) || b.buying.has(data.mint) ? 'disabled' : ''}>${this.busyBuys.has(data.mint) || b.buying.has(data.mint) ? '…' : a}</button>`).join('')}</div>
        <p class="small muted">The bot then sells it by your rules (take profit, stop loss, sellers taking over, time limit). ${mode === 'real' ? 'Uses SOL from the bot wallet.' : ''}</p>
        <div class="btn-row mt"><a class="btn" href="https://pump.fun/coin/${esc(data.mint)}" target="_blank" rel="noopener">pump.fun</a><button class="btn" data-action="copy" data-text="${esc(data.mint)}">Copy address</button></div>${close}`;
    } else if (kind === 'pos') {
      const p = b.positions.get(data.id);
      if (!p) { html = `<div class="empty"><b>This trade is closed</b>See the History tab for the result.</div>${close}`; }
      else html = this.posCard(p) + (p.buySig ? `<a class="btn ghost" href="https://solscan.io/tx/${esc(p.buySig)}" target="_blank" rel="noopener">View the buy on Solscan</a>` : '') + close;
    } else if (kind === 'hist') {
      const h = b.history.find((x) => x.id === data.id);
      if (!h) { this.closeSheet(); return; }
      html = `<div class="row">${avatar(h.symbol, h.mint)}<div><h2>${esc(h.name)}</h2><div class="muted">${esc(h.symbol)}</div></div></div>
        <dl class="kv mt"><dt>Result</dt><dd class="${cls(h.pnlLamports === null ? 0 : toSol(h.pnlLamports))}">${h.pnlLamports === null ? 'Unknown' : this.money(toSol(h.pnlLamports), { sign: true }) + (this.bot.solUsd ? ` (${signed(toSol(h.pnlLamports))} SOL)` : '')}</dd>
        <dt>Paid</dt><dd>${this.money(toSol(h.costLamports))}</dd><dt>Got back</dt><dd>${h.proceedsLamports === null ? '–' : this.money(toSol(h.proceedsLamports))}</dd>
        <dt>Why it sold</dt><dd>${esc(h.reason)}</dd><dt>Held for</dt><dd>${ago(h.openedAt, h.closedAt)}</dd><dt>Mode</dt><dd>${h.mode === 'real' ? 'Real' : 'Practice'}</dd></dl>
        <div class="stack mt">${h.buySig ? `<a class="btn" href="https://solscan.io/tx/${esc(h.buySig)}" target="_blank" rel="noopener">Buy on Solscan</a>` : ''}${h.sellSig ? `<a class="btn" href="https://solscan.io/tx/${esc(h.sellSig)}" target="_blank" rel="noopener">Sell on Solscan</a>` : ''}</div>${close}`;
    } else if (kind === 'mode') {
      const real = b.settings.mode === 'real';
      html = `<h2>Practice or real money?</h2><p class="lead">Both use live coins and the same rules. Practice uses pretend SOL, so nothing is at risk.</p>
        <div class="stack"><button class="style-card ${!real ? 'on' : ''}" data-action="set-mode" data-mode="practice"><strong>Practice</strong><p>Pretend SOL (${solNum(toSol(b.practice.balance))} left). Learn how the bot behaves.</p></button>
        <button class="style-card ${real ? 'on' : ''}" data-action="set-mode" data-mode="real"><strong>Real money</strong><p>Trades with the SOL in your bot wallet (${b.balance === null ? '…' : solNum(toSol(b.balance))} SOL). You can lose it.</p></button></div>
        ${b.running ? '<p class="small muted mt">Stop the bot before switching modes.</p>' : ''}${close}`;
    } else if (kind === 'deposit') {
      const addr = b.wallet?.address || '';
      html = `<h2>Add SOL</h2><p class="lead">Send SOL from Phantom (or any wallet or exchange) to the bot wallet.</p>
        <div class="secret"><div class="mono" style="font-size:15px">${esc(addr)}</div></div>
        <button class="btn primary mt" data-action="copy-address">Copy address</button>
        <div class="points"><div class="point"><span class="n">1</span><p><strong>Copy the address above</strong></p></div>
        <div class="point"><span class="n">2</span><p><strong>In Phantom tap Send → Solana</strong>Paste the address, enter an amount and send. Start small, like 0.1 to 0.3 SOL.</p></div>
        <div class="point"><span class="n">3</span><p><strong>Come back here</strong>The balance updates within a few seconds: <span class="money">${b.balance === null ? '…' : solNum(toSol(b.balance)) + ' SOL'}</span></p></div></div>
        <p class="small muted">Only send SOL on the Solana network.</p>${close}`;
    } else if (kind === 'practice') {
      const bal = toSol(b.practice.balance);
      const pending = Number(b.settings.pendingPracticeUsd) || 0;
      html = `<h2>Add practice money</h2><p class="lead">Pretend money for testing the bot on live coins. Real SOL can only come from your own wallet.</p>
        <div class="card tight"><div class="spread"><span class="muted">Practice balance</span><b class="money">${solNum(bal)} SOL${b.solUsd ? ` · $${(bal * b.solUsd).toLocaleString('en-US', { maximumFractionDigits: 0 })}` : ''}</b></div></div>
        ${pending ? `<div class="alert warn"><span class="ico">⏳</span><div class="grow">Adding $${pending} as soon as the SOL price loads.</div></div>` : ''}
        <div class="btn-row mt" style="grid-template-columns:repeat(2,1fr)">${[100, 500, 1000, 5000].map((u) => `<button class="btn go" data-action="practice-add" data-usd="${u}" ${b.solUsd ? '' : 'disabled'}>+$${u.toLocaleString('en-US')}</button>`).join('')}</div>
        <p class="small muted center">${b.solUsd ? `At today's SOL price ($${b.solUsd.toFixed(2)}).` : 'Waiting for the SOL price…'}</p>${close}`;
    } else if (kind === 'withdraw') {
      const openReal = [...b.positions.values()].filter((p) => p.mode === 'real').length;
      html = `<h2>Send SOL to Phantom</h2><p class="lead">Move SOL from the bot wallet to your own wallet. Balance: <span class="money">${b.balance === null ? '…' : solNum(toSol(b.balance)) + ' SOL'}</span></p>
        ${openReal ? `<div class="alert warn"><span class="ico">⚠️</span><div class="grow">You have ${openReal} open real trade${openReal > 1 ? 's' : ''}. Leave at least 0.01 SOL so the bot can pay the fee to sell.</div></div>` : ''}
        <div class="field mt"><label for="wd-to">Your Phantom address (Phantom → Receive → Solana → Copy)</label><div class="row"><input id="wd-to" class="input" placeholder="Solana address" autocapitalize="off" autocorrect="off" spellcheck="false" value="${esc(b.settings.lastWithdrawTo || '')}"><button class="btn small" data-action="paste" data-target="wd-to">Paste</button></div></div>
        <div class="field mt"><label for="wd-amt">Amount (SOL)</label><div class="row"><input id="wd-amt" class="input" inputmode="decimal" placeholder="0.1"><button class="btn small" data-action="wd-max">Max</button></div></div>
        <button class="btn go mt" data-action="wd-go">Send</button>${close}`;
    } else if (kind === 'backup') {
      html = `<h2>Backup key</h2><p class="lead">Anyone with this key controls the bot wallet. Only open this in private.</p>
        <div class="secret ${data.show ? '' : 'hidden-key'}"><div class="mono">${esc(b.exportSecret() || '')}</div></div>
        <div class="btn-row mt"><button class="btn" data-action="backup-show">${data.show ? 'Hide' : 'Show'}</button><button class="btn" data-action="copy-secret">Copy</button></div>
        <p class="small muted mt">To see this wallet in Phantom: Phantom → Add account → Import Private Key → paste.</p>
        ${!b.settings.backupDone ? `<label class="check mt"><input type="checkbox" data-action="backup-confirm"><span>I saved my backup key somewhere safe.</span></label>` : ''}${close}`;
    } else if (kind === 'import') {
      html = `<h2>Use a different wallet</h2><p class="lead">Paste the private key of a wallet made just for the bot. The current wallet's key is replaced on this phone, so back it up first if it holds anything.</p>
        <div class="field"><textarea id="imp-key" class="input" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Private key"></textarea></div>
        <div class="btn-row mt"><button class="btn" data-action="paste" data-target="imp-key">Paste</button><button class="btn primary" data-action="imp-go">Import</button></div>
        <button class="btn mt" data-action="new-wallet">Create a brand-new wallet instead</button>${close}`;
    } else if (kind === 'key') {
      html = `<h2>Data key</h2><p class="lead">Your free Helius API key (or any Solana mainnet https:// address). Get one at <a href="${HELIUS_SIGNUP}" target="_blank" rel="noopener">dashboard.helius.dev</a>.</p>
        <div class="field"><div class="row"><input id="key-input" class="input" value="${esc(b.settings.rpcInput || '')}" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Helius API key"><button class="btn small" data-action="paste" data-target="key-input">Paste</button></div></div>
        <div id="key-result"></div>
        <button class="btn primary mt" data-action="key-save">Test and save</button>${close}`;
    } else if (kind === 'activity') {
      html = `<h2>Activity</h2>${this.activityList(120)}${close}`;
    } else if (kind === 'help') {
      html = `<div class="help"><h2>How Win Bot works</h2>
        <h3>What it does</h3><p>It watches every new coin launched on pump.fun. When one starts getting real money, the bot studies it: for 10 seconds it reads every buy and sell, together with how the coin moved over the last minute. It counts real buyers (ignoring bot wallets that buy and sell over and over, and the mayhem agent), how much SOL is coming in versus going out, whether one whale is doing the buying, whether the creator is selling, and whether the price is holding. That becomes a score out of 100. Only coins that pass every check and score high enough get bought, after a last check that the coins are spread across many wallets.</p>
        <h3>How it sells</h3><p>It watches every trade on coins it holds and sells right away if the creator starts selling, a big holder dumps, or sellers take over. Otherwise it sells at your take profit, stop loss, trailing stop, or time limit, or if the coin is going nowhere. After losses in a row it gets pickier until the next win.</p>
        <h3>Mayhem coins</h3><p>Mayhem coins have pump.fun's trading agent buying and selling them, which can fake activity. The bot ignores the agent's trades, needs a higher score and a clearly rising price, and takes a quick $5 to $10 profit (more only while it's still flying).</p>
        <h3>Copy trading</h3><p>On the Wallets tab, add a trader by wallet address, pump.fun profile link, or @username. You'll see their pump.fun and PumpSwap trades live. Turn on Copy and the bot buys the same coin when they buy (with your amount), including graduated coins on PumpSwap, and sells the same share when they sell. It skips a copy if the price already ran up 25% since their buy. Your stop loss still protects copied trades. Copying works whenever Win Bot is open on screen, even if the bot isn't started.</p>
        <h3>Keep the app open</h3><p>iPhone pauses web apps in the background, so the bot only trades while Win Bot is open on screen. When it's running it keeps the screen on by itself; plug your phone in. If you leave and come back, it checks your trades right away and sells anything that hit a rule.</p>
        <h3>Practice vs real</h3><p>Practice uses pretend SOL with the same live coins and rules, with prices made 2% worse to be realistic. Real mode uses the SOL in your bot wallet.</p>
        <h3>Fees</h3><p>pump.fun charges about 1.25% per trade. Each trade also pays a small network fee (about 0.0001 to 0.0005 SOL depending on Speed). The first trade of each coin puts about 0.002 SOL into a token account; the bot gets it back after selling.</p>
        <h3>Safety</h3><p>Most pump.fun coins go to zero, and no bot wins every trade: the study cuts out a lot of bad coins, but it can't see the future. Start in Practice, then use small amounts. The bot never sells coins it didn't buy unless you tap Sell. Every real trade is test-run on the network first and cancelled if it would move more SOL than expected.</p>
        <h3>If something goes wrong</h3><p>Your SOL is always in the bot wallet on Solana. With your backup key you can open it in Phantom from any device and sell or send anything there.</p></div>${close}`;
    }
    if (this.sheetRendered === kind + JSON.stringify(data)) patch(body, html);
    else { body.innerHTML = html; this.sheetRendered = kind + JSON.stringify(data); }
  }

  studyReport(c) {
    const v = c.verdict;
    const m = v.m || {};
    const studying = c.stage === 'study';
    const left = studying ? Math.max(0, Math.ceil((c.studyEnd - Date.now()) / 1000)) : 0;
    const title = c.stage === 'bought' || c.stage === 'passed' ? 'Passed the study' : studying ? `Studying · ${left}s left` : v.ok ? 'Looked good' : 'Did not pass';
    const sub = v.ok ? `Score ${v.score} (needs ${v.need})` : v.reason;
    return `<div class="verdict">${scoreRing(v.score, v.ok ? 'pass' : studying ? '' : 'fail', true)}<div><h4>${esc(title)}</h4><div class="small muted">${esc(sub)}</div></div></div>
      <dl class="kv mt">
        <dt>Real buyers</dt><dd>${m.uniqueBuyers ?? '–'}</dd>
        <dt>Money in, net</dt><dd class="${cls(m.netSol || 0)}">${m.netSol !== undefined ? (m.netSol >= 0 ? '+' : '') + m.netSol.toFixed(2) + ' SOL' : '–'}</dd>
        <dt>Buys vs sells</dt><dd>${m.buyRatio !== undefined ? Math.round(m.buyRatio * 100) + '% buys' : '–'}</dd>
        <dt>Trades studied</dt><dd>${m.trades ?? '–'}${m.flippers ? ` (${m.flippers} bot wallet${m.flippers > 1 ? 's' : ''} ignored)` : ''}</dd>
        <dt>Creator</dt><dd class="${m.creatorSoldSol > 0.05 ? 'down' : ''}">${m.creatorSoldSol > 0.05 ? 'sold ' + m.creatorSoldSol.toFixed(2) + ' SOL' : 'not selling'}</dd>
      </dl>
      <div class="report">${v.parts.map((p) => `<div class="bar-line"><span>${esc(p.label)} <span class="small muted">${esc(p.note || '')}</span></span><span class="pts">${p.pts}/${p.max}</span><div class="meter"><i style="width:${p.max ? Math.round((p.pts / p.max) * 100) : 0}%"></i></div></div>`).join('')}</div>
      ${v.vetoes.length ? `<ul class="reasons">${v.vetoes.slice(0, 5).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<ul class="reasons"><li class="good">No red flags</li></ul>'}`;
  }

  // ---------- dialogs & toasts ----------

  confirm({ title, text, ok = 'OK', cancel = 'Cancel', danger = false, typeWord = null }) {
    return new Promise((resolve) => {
      const root = document.createElement('div');
      root.innerHTML = `<div class="backdrop dialog-back"></div><div class="dialog" role="alertdialog" aria-modal="true"><h3>${esc(title)}</h3><p>${esc(text)}</p>
        ${typeWord ? `<input class="input" id="dlg-word" placeholder="Type ${esc(typeWord)}" autocapitalize="characters" autocorrect="off" style="margin-bottom:12px">` : ''}
        <div class="btn-row"><button class="btn" data-dlg="no">${esc(cancel)}</button><button class="btn ${danger ? 'danger' : 'primary'}" data-dlg="yes">${esc(ok)}</button></div></div>`;
      document.body.appendChild(root);
      const done = (v) => { root.remove(); resolve(v); };
      root.addEventListener('click', (e) => {
        const d = e.target.closest('[data-dlg]');
        if (e.target.classList.contains('backdrop')) return done(false);
        if (!d) return;
        if (d.dataset.dlg === 'yes' && typeWord && root.querySelector('#dlg-word').value.trim().toUpperCase() !== typeWord) {
          root.querySelector('#dlg-word').focus();
          return;
        }
        done(d.dataset.dlg === 'yes');
      });
    });
  }

  message(title, text) { return this.confirm({ title, text, ok: 'OK', cancel: 'Close' }); }

  toast(text, kind = '') {
    const box = document.getElementById('toasts');
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.textContent = text;
    box.prepend(el);
    while (box.children.length > 3) box.lastChild.remove();
    setTimeout(() => el.remove(), 3500);
  }

  _toastNewActivity() {
    const fresh = this.bot.activity.filter((a) => a.t > this.seenActivity);
    if (!fresh.length) return;
    this.seenActivity = fresh[0].t;
    for (const a of fresh.slice(0, 2).reverse()) if (['buy', 'win', 'loss', 'error'].includes(a.level)) this.toast(a.message, a.level);
  }

  // ---------- events ----------

  async _onClick(e) {
    const t = e.target.closest('[data-action]');
    if (!t || t.disabled) return;
    const a = t.dataset.action;
    const b = this.bot;
    try {
      switch (a) {
        case 'tab': this.tab = t.dataset.tab; this.renderAll(); window.scrollTo(0, 0); break;
        case 'close-sheet': this.closeSheet(); break;
        case 'power': await this.power(); break;
        case 'resume': b.resume(); break;
        case 'keep-awake': await this.wake.request(); this.scheduleUpdate(); break;
        case 'dismiss-a2hs': this.a2hsDismissed = true; this.store.save('a2hsDismissed', true); this.renderTab(); break;
        case 'mode-sheet': this.openSheet('mode'); break;
        case 'set-mode': await this.setMode(t.dataset.mode); break;
        case 'coin-view': this.coinView = t.dataset.view; this.renderCoinsShell(); break;
        case 'trades-view': this.tradesView = t.dataset.view; this.renderTrades(); break;
        case 'coin': this.openSheet('coin', { mint: t.dataset.mint }); break;
        case 'pos': this.openSheet('pos', { id: t.dataset.id }); break;
        case 'hist': this.openSheet('hist', { id: t.dataset.id }); break;
        case 'activity': this.openSheet('activity'); break;
        case 'help': this.openSheet('help'); break;
        case 'deposit': this.openSheet('deposit'); break;
        case 'practice-sheet': if (!b.solUsd) b.refreshSolPrice(); this.openSheet('practice'); break;
        case 'practice-add': {
          const usd = Number(t.dataset.usd);
          const lam = b.addPracticeUsd(usd);
          this.toast(`Added $${usd.toLocaleString('en-US')} (${solNum(toSol(lam))} SOL) to practice.`);
          this.renderSheet();
          break;
        }
        case 'withdraw': b.refreshBalance().catch(() => {}); this.openSheet('withdraw'); break;
        case 'backup': {
          const ok = await this.confirm({ title: 'Show your backup key?', text: 'Make sure nobody can see your screen. Anyone with this key can take the bot wallet’s SOL.', ok: 'Continue' });
          if (ok) this.openSheet('backup', { show: false });
          break;
        }
        case 'backup-show': this.sheet.data.show = !this.sheet.data.show; this.renderSheet(); break;
        case 'backup-confirm': b.updateSettings({ backupDone: true }); this.toast('Backup confirmed.'); break;
        case 'import': this.openSheet('import'); break;
        case 'edit-key': this.openSheet('key'); break;
        case 'paste': {
          const v = await pasteText();
          const el = document.getElementById(t.dataset.target);
          if (v === null) this.toast('Tap and hold the box, then tap Paste.');
          else if (el) el.value = v.trim();
          break;
        }
        case 'copy': if (await copyText(t.dataset.text)) this.toast('Copied.'); break;
        case 'copy-address': if (b.wallet && (await copyText(b.wallet.address))) this.toast('Address copied.'); break;
        case 'copy-secret': if (await copyText(b.exportSecret() || '')) this.toast('Backup key copied. Paste it somewhere safe.'); break;
        case 'paste-mint': { const v = await pasteText(); if (v === null) this.toast('Tap and hold the box, then tap Paste.'); else document.getElementById('paste-mint').value = v.trim(); break; }
        case 'open-pasted': {
          const v = (document.getElementById('paste-mint')?.value || '').trim();
          const m = v.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
          if (!m || !isAddress(m[0])) { this.toast("That isn't a coin address."); break; }
          this.openSheet('coin', { mint: m[0] });
          break;
        }
        case 'buy': await this.buy(t.dataset.mint, Number(t.dataset.sol)); break;
        case 'sell': await this.sell(t.dataset.id); break;
        case 'sell-part': {
          const p = b.positions.get(t.dataset.id);
          const f = Number(t.dataset.fraction);
          if (!p || !(f > 0)) break;
          const ok = await this.confirm({ title: `Sell ${Math.round(f * 100)}% of ${p.symbol}?`, text: p.mode === 'real' ? 'Sells that part at the current price. The bot keeps managing the rest.' : 'Sells that part of your practice position at the current price.', ok: 'Sell', danger: true });
          if (ok) { b.sellPart(t.dataset.id, f); this.toast(`Selling ${Math.round(f * 100)}% of ${p.symbol}…`); }
          break;
        }
        case 'do-update': { const u = this.updateOffer; if (u) { t.disabled = true; t.textContent = 'Updating…'; await u.go(); } break; }
        case 'sell-all': {
          const ok = await this.confirm({ title: 'Sell everything now?', text: 'The bot sells every open trade at the current price.', ok: 'Sell all', danger: true });
          if (ok) b.sellAll();
          break;
        }
        case 'set': b.updateSettings({ [t.dataset.key]: t.dataset.value }); this.renderSettings(); break;
        case 'reset-rules': b.updateSettings({ tradeSol: null, maxOpen: null, takeProfitPct: null, stopLossPct: null, trailStartPct: null, trailDropPct: null, maxHoldMin: null, dailyLossSol: null, studySec: 10, mayhemStudySec: 10, mayhemProfitMinUsd: 5, mayhemProfitMaxUsd: 10 }); this.renderSettings(); this.toast('Rules reset to the style defaults.'); break;
        case 'track': await this.trackWallet(); break;
        case 'wallet-refresh': b.refreshWallet(t.dataset.address).catch((e2) => this.toast(e2.message)); break;
        case 'wallet-remove': {
          const open = [...b.positions.values()].filter((p) => p.copiedFrom === t.dataset.address).length;
          const ok = await this.confirm({ title: `Stop tracking ${b.walletLabel(t.dataset.address)}?`, text: open ? `You have ${open} open copied trade${open > 1 ? 's' : ''}. They stay open and use your normal rules.` : 'You can add them again any time.', ok: 'Remove', danger: true });
          if (ok) {
            for (const p of b.positions.values()) if (p.copiedFrom === t.dataset.address) p.copiedFrom = null;
            b.untrackWallet(t.dataset.address);
            this.renderWallets();
          }
          break;
        }
        case 'reset-practice': {
          const ok = await this.confirm({ title: 'Reset practice?', text: `Practice balance goes back to ${b.settings.practiceStartSol} SOL and practice history is cleared.`, ok: 'Reset' });
          if (ok) { b.resetPractice(); this.renderSettings(); }
          break;
        }
        case 'wd-max': {
          const bal = toSol(b.balance ?? 0n);
          document.getElementById('wd-amt').value = Math.max(0, bal - 0.002).toFixed(4);
          break;
        }
        case 'wd-go': await this.withdraw(t); break;
        case 'imp-go': await this.importWallet(document.getElementById('imp-key')?.value); break;
        case 'new-wallet': await this.newWallet(); break;
        case 'key-save': await this.saveKey(t); break;
        case 'erase': {
          const ok = await this.confirm({ title: 'Erase everything?', text: 'This deletes the bot wallet key, settings and history from this phone. Back up your key first if the wallet holds anything.', ok: 'Erase', danger: true, typeWord: 'ERASE' });
          if (ok) { b.eraseEverything(); location.reload(); }
          break;
        }
        // wizard
        case 'wiz-next': {
          const keyEl = document.getElementById('wiz-key');
          if (this.wiz.step === 1 && keyEl && keyEl.value.trim() !== (b.settings.rpcInput || '')) { await this.wizTestKey(); break; }
          this.wiz.step++; this.renderWizard(); window.scrollTo(0, 0); break;
        }
        case 'wiz-back': this.wiz.step = Math.max(0, this.wiz.step - 1); this.renderWizard(); break;
        case 'wiz-paste-key': { const v = await pasteText(); if (v === null) this.toast('Tap and hold the box, then tap Paste.'); else { this.wiz.key = v.trim(); this.wiz.keyTest = null; this.renderWizard(); } break; }
        case 'wiz-test-key': await this.wizTestKey(); break;
        case 'wiz-create': {
          this.wiz.busy = true; this.renderWizard();
          try { await b.createWallet(); this.wiz.step = 3; } finally { this.wiz.busy = false; }
          this.renderWizard();
          break;
        }
        case 'wiz-import-toggle': this.wiz.importing = !this.wiz.importing; this.renderWizard(); break;
        case 'wiz-paste-import': { const v = await pasteText(); if (v === null) this.toast('Tap and hold the box, then tap Paste.'); else document.getElementById('wiz-import').value = v.trim(); break; }
        case 'wiz-import': {
          await b.importWallet(document.getElementById('wiz-import').value);
          this.toast('Wallet imported.');
          this.wiz.step = 4; this.renderWizard();
          break;
        }
        case 'wiz-show-key': this.wiz.showKey = !this.wiz.showKey; this.renderWizard(); break;
        case 'wiz-backup-done': b.updateSettings({ backupDone: true }); this.wiz.step = 4; this.renderWizard(); break;
        case 'wiz-style': this.wiz.style = t.dataset.style; this.renderWizard(); break;
        case 'wiz-finish': b.updateSettings({ style: this.wiz.style, mode: 'practice', setupDone: true }); this.tab = 'home'; this.renderAll(); this.toast('All set. Tap Start to practice.'); break;
      }
    } catch (err) {
      this.message('Something went wrong', err?.message || String(err));
    }
  }

  _onChange(e) {
    const t = e.target;
    if (t.id === 'wiz-backup') { this.wiz.backupChecked = t.checked; this.renderWizard(); return; }
    if (t.id === 'wiz-key') { this.wiz.key = t.value.trim(); return; }
    if (t.dataset.setting) { this.bot.updateSettings({ [t.dataset.setting]: t.checked }); return; }
    if (t.dataset.settingInverse) { this.bot.updateSettings({ [t.dataset.settingInverse]: !t.checked }); return; }
    if (t.dataset.walletCopy) { this.toggleCopy(t.dataset.walletCopy, t); return; }
    if (t.dataset.walletSol) {
      try { this.bot.updateWallet(t.dataset.walletSol, { copySol: t.value.replace(',', '.').trim() }); this.toast('Saved.'); }
      catch (err) { this.toast(err.message); }
      this.renderWallets();
      return;
    }
    if (t.dataset.num) {
      const v = t.value.replace(',', '.').trim();
      if (v === '') { this.bot.updateSettings({ [t.dataset.num]: null }); this.renderSettings(); return; }
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) { this.toast('Enter a number above zero.'); this.renderSettings(); return; }
      this.bot.updateSettings({ [t.dataset.num]: n });
      const eff = resolveRules(this.bot.settings)[t.dataset.num];
      if (eff !== n) this.toast(`Adjusted to ${eff} (the allowed range).`);
      this.renderSettings();
    }
  }

  // ---------- actions ----------

  async power() {
    const b = this.bot;
    if (b.running) { b.stop(); this.toast('Bot stopped. Open trades are still managed.'); if (!b.positions.size) this.wake.release(); return; }
    if (b.settings.mode === 'real' && !this.store.load('realConfirmed', false)) {
      const ok = await this.confirm({ title: 'Start with real SOL?', text: 'The bot will buy and sell with the SOL in your bot wallet. Memecoins can drop to zero fast. Only use what you can afford to lose.', ok: 'Start', danger: true });
      if (!ok) return;
      this.store.save('realConfirmed', true);
    }
    const awake = this.wake.request();
    try {
      await b.start();
      await awake;
      this.toast(b.settings.mode === 'real' ? 'Bot started with real SOL.' : 'Practice started. Watch the Coins tab.');
    } catch (e) {
      const msg = e.message || String(e);
      if (/Add SOL/.test(msg)) { await this.message("Can't start yet", msg); this.openSheet('deposit'); }
      else if (/data key/.test(msg)) { await this.message("Can't start yet", msg); this.openSheet('key'); }
      else await this.message("Can't start yet", msg);
      if (!b.positions.size) this.wake.release();
    }
    this.scheduleUpdate();
  }

  async setMode(mode) {
    const b = this.bot;
    if (b.settings.mode === mode) { this.closeSheet(); return; }
    if (b.running) { this.toast('Stop the bot first.'); return; }
    if (mode === 'real') {
      const ok = await this.confirm({ title: 'Switch to real money?', text: 'Trades will use the SOL in your bot wallet. You can switch back to Practice any time.', ok: 'Use real SOL', danger: true });
      if (!ok) return;
      b.refreshBalance().catch(() => {});
    }
    b.updateSettings({ mode });
    this.closeSheet();
    this.renderAll();
    this.toast(mode === 'real' ? 'Real money mode.' : 'Practice mode.');
  }

  async buy(mint, sol) {
    const b = this.bot;
    if (this.busyBuys.has(mint) || b.buying.has(mint)) return;
    this.busyBuys.add(mint); // locks the buttons, even across screen updates
    this.renderSheet();
    try {
      if (b.settings.mode === 'real') {
        const ok = await this.confirm({ title: `Buy for ${sol} SOL?`, text: 'Real SOL from your bot wallet. The bot then sells it by your rules.', ok: 'Buy' });
        if (!ok) return;
      }
      await b.manualBuy(mint, sol);
      this.closeSheet();
    } catch (e) {
      this.message("Couldn't buy", e.message || String(e));
    } finally {
      this.busyBuys.delete(mint);
      this.renderSheet();
    }
  }

  async sell(id) {
    const p = this.bot.positions.get(id);
    if (!p) return;
    const ok = await this.confirm({ title: `Sell ${p.symbol} now?`, text: p.mode === 'real' ? 'Sells all of it at the current price.' : 'Sells your practice position at the current price.', ok: 'Sell', danger: true });
    if (ok) this.bot.sellNow(id);
  }

  async withdraw(btn) {
    const to = (document.getElementById('wd-to')?.value || '').trim();
    const amtText = (document.getElementById('wd-amt')?.value || '').replace(',', '.').trim();
    const bal = toSol(this.bot.balance ?? 0n);
    const amt = Number(amtText);
    if (!isAddress(to)) { this.message('Check the address', "That isn't a Solana address. In Phantom tap Receive → Solana → Copy, then paste it here."); return; }
    if (!(amt > 0)) { this.message('Check the amount', 'Enter how much SOL to send.'); return; }
    const isMax = Math.abs(amt - Math.max(0, bal - 0.002)) < 0.00005;
    const ok = await this.confirm({ title: `Send ${amt} SOL?`, text: `To ${short(to)}. Double-check it's your own wallet: Solana transfers can't be undone.`, ok: 'Send', danger: true });
    if (!ok) return;
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      await this.bot.withdraw(to, isMax ? 'max' : amt);
      this.bot.updateSettings({ lastWithdrawTo: to });
      this.closeSheet();
      this.toast('Sent. It shows in Phantom within a minute.');
    } catch (e) {
      this.message("Couldn't send", e.message || String(e));
      btn.disabled = false; btn.textContent = 'Send';
    }
  }

  async importWallet(text) {
    const b = this.bot;
    let confirmedBackup = false;
    if (b.wallet) {
      confirmedBackup = await this.confirm({ title: 'Replace the current wallet?', text: 'Did you save the current wallet\u2019s backup key? A wallet that still holds SOL or coins can\u2019t be replaced: send it to Phantom first.', ok: 'Yes, replace', danger: true });
      if (!confirmedBackup) return;
    }
    await b.importWallet(text, { confirmedBackup });
    this.closeSheet();
    this.renderAll();
    this.toast('Wallet imported.');
  }

  async newWallet() {
    const b = this.bot;
    const ok = await this.confirm({ title: 'Create a new wallet?', text: 'Did you save the current wallet\u2019s backup key? A wallet that still holds SOL or coins can\u2019t be replaced: send it to Phantom first.', ok: 'Yes, create', danger: true });
    if (!ok) return;
    await b.createWallet({ confirmedBackup: true });
    this.closeSheet();
    this.renderAll();
    this.openSheet('backup', { show: true });
  }

  async trackWallet() {
    const input = document.getElementById('track-input');
    const v = (input?.value || '').trim();
    if (!v) { this.toast('Paste a wallet address or @username first.'); return; }
    this.tracking = true;
    this.renderWallets();
    try {
      const w = await this.bot.trackWallet(v);
      if (input) input.value = '';
      this.toast('Tracking ' + this.bot.walletLabel(w.address) + '.');
    } catch (e) {
      this.message("Couldn't add that wallet", e.message || String(e));
    } finally {
      this.tracking = false;
      this.renderWallets();
    }
  }

  async toggleCopy(address, box) {
    const b = this.bot;
    const w = b.wallets.find((x) => x.address === address);
    if (!w) return;
    if (box.checked) {
      const real = b.settings.mode === 'real';
      const ok = await this.confirm({
        title: `Copy ${b.walletLabel(address)}?`,
        text: `Each time they buy a pump.fun coin, the bot buys ${w.copySol} SOL of it${real ? ' with REAL SOL' : ' (practice SOL)'} right away, and sells when they sell. It copies whenever Win Bot is open on screen.`,
        ok: 'Copy them', danger: real,
      });
      if (!ok) { box.checked = false; return; }
    }
    b.updateWallet(address, { copy: box.checked });
    this.renderWallets();
    if (box.checked) this.toast(`Copying ${b.walletLabel(address)}. Keep Win Bot open on screen.`);
  }

  async lookupCoin(mint) {
    if (!this.bot.rpc) return;
    try {
      const info = await this.bot.lookupCoin(mint);
      if (this.sheet?.kind === 'coin' && this.sheet.data.mint === mint) { Object.assign(this.sheet.data, info); this.renderSheet(); }
    } catch (e) {
      if (this.sheet?.kind === 'coin' && this.sheet.data.mint === mint) { this.sheet.data.error = e.message; this.renderSheet(); }
    }
  }

  async wizTestKey() {
    const input = document.getElementById('wiz-key');
    this.wiz.key = (input?.value || this.wiz.key).trim();
    this.wiz.busy = true; this.renderWizard();
    try {
      const r = await this.bot.testConnection(this.wiz.key);
      this.wiz.keyTest = r;
      if (r.ok) this.bot.updateSettings({ rpcInput: this.wiz.key });
    } finally {
      this.wiz.busy = false;
      this.renderWizard();
    }
  }

  async saveKey(btn) {
    const v = (document.getElementById('key-input')?.value || '').trim();
    btn.disabled = true; btn.textContent = 'Testing…';
    const r = await this.bot.testConnection(v);
    const box = document.getElementById('key-result');
    if (box) box.innerHTML = `<div class="alert ${r.ok ? 'ok' : 'error'}"><span class="ico">${r.ok ? '✅' : '⚠️'}</span><div class="grow">${esc(r.message)}</div></div>`;
    btn.disabled = false; btn.textContent = 'Test and save';
    if (r.ok) { this.bot.updateSettings({ rpcInput: v }); this.toast('Data key saved.'); setTimeout(() => this.closeSheet(), 700); this.renderSettings(); }
  }
}
