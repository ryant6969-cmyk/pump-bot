// Everything on screen. Plain DOM, no framework. Every value that comes from
// the network or a coin (names, symbols, errors) is escaped before display.

import * as pump from './pump.js';
import { STYLES, SPEEDS, resolveRules } from './strategy.js';
import { isAddress } from './b58.js';

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const ICONS = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/></svg>',
  coins: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/></svg>',
  trades: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 9h10M7 13h6M7 17h4"/></svg>',
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
  return `<span class="avatar" style="background:hsl(${hue(mint)} 70% 62%)">${esc(letters)}</span>`;
}
function cls(sol) { return sol > 0 ? 'up' : sol < 0 ? 'down' : ''; }

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
    this.coinView = 'hot';
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
    else if (this.tab === 'trades') this.renderTrades();
    else if (this.tab === 'settings') this.updateSettingsLive();
    this.updateSheet();
  }

  tabbar() {
    const open = this.bot.positions.size;
    const t = (id, label) => `<button data-action="tab" data-tab="${id}" class="${this.tab === id ? 'on' : ''}" aria-label="${label}">${ICONS[id]}<span>${label}</span>${id === 'trades' && open ? `<span class="count">${open}</span>` : ''}</button>`;
    return `<nav class="tabbar">${t('home', 'Home')}${t('coins', 'Coins')}${t('trades', 'Trades')}${t('settings', 'Settings')}</nav>`;
  }

  renderTab() {
    if (this.tab === 'home') this.renderHome();
    else if (this.tab === 'coins') this.renderCoinsShell();
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
    const openPos = [...b.positions.values()];
    const usd = b.solUsd ? '$' + (bal * b.solUsd).toFixed(2) : '';
    const alerts = [...b.alerts.values()];
    const statusText = this.powerStatus();
    const feedLive = b.feed?.isLive();
    const pricesOk = b.lastPollAt && Date.now() - b.lastPollAt < 12000;
    const awake = this.wake.held();
    const needAwake = b.running || openPos.length > 0;
    patch(el, `
      <div class="bar">
        <h1 class="title" style="margin:4px 0 0">Win Bot</h1>
        <button class="pill mode" data-action="mode-sheet">${real ? 'REAL' : 'PRACTICE'}</button>
      </div>
      ${this.homeBanners()}
      <div class="card balance">
        <div class="spread"><span class="label">${real ? 'Bot wallet' : 'Practice balance'}</span>${real ? `<button class="btn small" data-action="deposit">Add SOL</button>` : ''}</div>
        <div class="amount money">${solNum(bal)} <small>SOL</small></div>
        <div class="usd">${usd}${real && b.balance === null ? 'Checking balance…' : ''}</div>
        <div class="today">
          <span class="chip ${cls(today)}"><span class="num">${signed(today)} SOL</span> today</span>
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
      <div class="lights">
        <div class="light">Coin feed<div class="row"><span class="dot ${!b.running ? '' : feedLive ? 'ok' : 'warn'}"></span>${!b.running ? 'Off' : feedLive ? 'Live' : 'Connecting'}</div></div>
        <div class="light">Prices<div class="row"><span class="dot ${b.alerts.has('rpc') ? 'bad' : pricesOk ? 'ok' : ''}"></span>${b.alerts.has('rpc') ? 'Problem' : pricesOk ? 'Live' : 'Idle'}</div></div>
        <button class="light" data-action="keep-awake" style="text-align:left">Screen<div class="row"><span class="dot ${!needAwake ? '' : awake ? 'ok' : 'warn'}"></span>${!needAwake ? 'Normal' : awake ? 'Stays on' : 'Tap: keep on'}</div></button>
      </div>
      ${alerts.map((a) => `<div class="alert ${esc(a.level)}"><span class="ico">${a.level === 'error' ? '⚠️' : a.level === 'warn' ? '⏸' : 'ℹ️'}</span><div class="grow">${esc(a.message)}</div></div>`).join('')}
      ${needAwake ? `<div class="alert"><span class="ico">📱</span><div class="grow"><strong>Keep Win Bot open on screen.</strong> iPhone pauses apps in the background, so the bot only trades while it's open. Plug your phone in; the screen stays on by itself.</div></div>` : ''}
      ${openPos.length ? `<div class="section-title">Open trades</div><div class="list">${openPos.map((p) => this.posRow(p)).join('')}</div>` : ''}
      <div class="section-title spread"><span>Activity</span>${b.activity.length > 4 ? '<button class="btn ghost small" data-action="activity" style="min-height:24px;padding:0">See all</button>' : ''}</div>
      ${this.activityList(4)}
      <p class="small muted center mt2">Memecoins are extremely risky and most go to zero. Only use SOL you can afford to lose. Not financial advice.</p>
    `);
  }

  homeBanners() {
    const out = [];
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
    if (!b.settings.autoBuy) return 'Manual mode: pick coins on the Coins tab. The bot sells them for you.';
    if (b.buyInFlight) return '<strong>Checking a coin…</strong>';
    if (b.entryBlock) return esc(b.entryBlock);
    const watching = [...b.coins.values()].filter((c) => c.watching).length;
    if (!b.feed?.isLive() && !watching) return 'Connecting to the live coin feed…';
    return `Watching <strong>${watching}</strong> new coin${watching === 1 ? '' : 's'} for a strong move.`;
  }

  posRow(p) {
    const cost = toSol(p.costLamports);
    const value = p.lastValueLamports !== undefined ? toSol(p.lastValueLamports) : null;
    const pnl = value !== null ? value - cost : null;
    const pp = value !== null && cost > 0 ? (pnl / cost) * 100 : null;
    const state = p.state === 'selling' ? 'Selling…' : p.found ? 'In wallet' : p.lastError && p.sellAttempts ? 'Retrying sale' : 'Held ' + ago(p.openedAt);
    return `<button class="item" data-action="pos" data-id="${esc(p.id)}">${avatar(p.symbol, p.mint)}
      <div class="grow"><div style="font-weight:650">${esc(p.symbol)} <span class="badge ${p.mode}">${p.mode === 'real' ? 'REAL' : 'PRACTICE'}</span></div><div class="small muted">${esc(state)}</div></div>
      <div class="val"><div class="${cls(pnl ?? 0)}" style="font-weight:700;font-size:17px">${pp !== null ? pct(pp) : '…'}</div><div class="small">${value !== null ? solNum(value) + ' SOL' : ''}</div></div></button>`;
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
      <div class="row mt" style="margin-bottom:10px"><div class="seg" style="flex:1"><button data-action="coin-view" data-view="hot" class="${this.coinView === 'hot' ? 'on' : ''}">Moving</button><button data-action="coin-view" data-view="new" class="${this.coinView === 'new' ? 'on' : ''}">Newest</button></div></div>
      <div id="coin-head" class="small muted" style="margin:0 4px 8px"></div>
      <div id="coin-list"></div>`;
    this.updateCoins();
  }

  updateCoins() {
    const list = document.getElementById('coin-list');
    if (!list) return;
    const b = this.bot;
    const now = Date.now();
    let coins = [...b.coins.values()];
    const rise = (c) => {
      const s = c.snaps; if (!s || s.length < 2) return 0;
      const last = s[s.length - 1];
      let ref = s[0]; for (const x of s) { if (x.t <= last.t - 60000) ref = x; else break; }
      return ref.mcap > 0 ? (last.mcap / ref.mcap - 1) * 100 : 0;
    };
    if (this.coinView === 'hot') coins = coins.filter((c) => c.snaps.length >= 2 && c.watching).sort((a, c) => rise(c) - rise(a));
    else coins.sort((a, c) => c.createdAt - a.createdAt);
    coins = coins.slice(0, 60);
    const head = document.getElementById('coin-head');
    if (head) head.textContent = b.running ? `${b.coins.size} coins seen · ${b.feed?.isLive() ? 'live' : 'connecting…'}` : 'Start the bot on Home to see coins launching live.';
    if (!coins.length) {
      patch(list, `<div class="list"><div class="empty"><b>${b.running ? 'Waiting for coins…' : 'The coin feed is off'}</b>${b.running ? 'New pump.fun coins appear here within seconds.' : 'Tap Start on the Home tab. You can still paste a coin address above.'}</div></div>`);
      return;
    }
    patch(list, `<div class="list">${coins.map((c) => this.coinRow(c, rise(c), now)).join('')}</div>`);
  }

  coinRow(c, r, now) {
    const held = this.bot.positions.has(this.bot.settings.mode + ':' + c.mint);
    const prog = Math.round((c.lastProgress || 0) * 100);
    const status = held ? 'You hold this coin' : c.status || (c.eval ? (c.eval.ok ? 'Passed the price rules' : c.eval.reason) : c.snaps.length ? '' : 'Loading price…');
    return `<button class="coin" data-action="coin" data-mint="${esc(c.mint)}">${avatar(c.symbol, c.mint)}
      <div class="name">${esc(c.name)}<small>${esc(c.symbol)}</small></div>
      <div class="right">${this.mcapText(c.lastMcap)}<div class="change ${cls(r)}">${c.snaps.length >= 2 ? pct(r) + ' 1m' : ''}</div></div>
      <div class="meta"><span>${ago(c.createdAt, now)}</span><span class="rail"><i style="width:${prog}%"></i></span><span>${prog}%</span></div>
      ${status ? `<div class="status ${held || c.status === 'Bought' ? 'good' : ''}">${esc(status)}</div>` : ''}</button>`;
  }

  mcapText(sol) {
    if (!sol) return '–';
    if (this.bot.solUsd) {
      const usd = sol * this.bot.solUsd;
      return '$' + (usd >= 1e6 ? (usd / 1e6).toFixed(2) + 'M' : usd >= 1e3 ? (usd / 1e3).toFixed(1) + 'K' : usd.toFixed(0));
    }
    return sol.toFixed(1) + ' SOL';
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
      body = open.length ? open.map((p) => this.posCard(p)).join('') + (open.length > 1 ? `<button class="btn danger mt" data-action="sell-all">Sell everything now</button>` : '')
        : `<div class="list"><div class="empty"><b>No open trades</b>${b.running ? 'The bot buys when a coin passes its rules.' : 'Start the bot on Home, or buy a coin from the Coins tab.'}</div></div>`;
    } else {
      const st = b.stats(mode);
      const rate = st.trades ? Math.round((st.wins / st.trades) * 100) + '%' : '–';
      const hist = b.history.filter((h) => h.mode === mode).slice(0, 100);
      body = `<div class="stats"><div class="stat"><b class="${cls(toSol(st.totalLamports))}">${signed(toSol(st.totalLamports))}</b><span>Total SOL</span></div><div class="stat"><b>${rate}</b><span>Win rate</span></div><div class="stat"><b>${st.trades}</b><span>Trades</span></div></div>
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
    else state = `Sells at ${pct(rules.takeProfitPct)} or ${pct(-rules.stopLossPct)}, or after ${rules.maxHoldMin} min.`;
    return `<div class="card pos">
      <div class="top">${avatar(p.symbol, p.mint)}<div class="grow" style="flex:1"><div style="font-weight:700">${esc(p.name)}</div><div class="small muted">${esc(p.symbol)} · <span class="badge ${p.mode}">${p.mode === 'real' ? 'REAL' : 'PRACTICE'}</span></div></div>
      <div class="pnl ${cls(pnl ?? 0)}">${pp !== null ? pct(pp) : '…'}<small>${pnl !== null ? signed(pnl) + ' SOL' : 'pricing…'}</small></div></div>
      <div class="facts"><div class="fact"><b>${solNum(cost)}</b><span>Paid (SOL)</span></div><div class="fact"><b>${value !== null ? solNum(value) : '–'}</b><span>Worth now</span></div><div class="fact"><b>${p.complete ? 'Graduated' : Math.round((p.progress || 0) * 100) + '%'}</b><span>Curve</span></div></div>
      <div class="state">${state}</div>
      <div class="actions"><button class="btn danger small" style="flex:1" data-action="sell" data-id="${esc(p.id)}" ${p.state === 'selling' ? 'disabled' : ''}>Sell now</button>
      <a class="btn small" style="flex:1" href="https://pump.fun/coin/${esc(p.mint)}" target="_blank" rel="noopener">Chart</a></div></div>`;
  }

  histRow(h) {
    const pnl = h.pnlLamports === null ? null : toSol(h.pnlLamports);
    const cost = toSol(h.costLamports);
    const pp = pnl !== null && cost > 0 ? (pnl / cost) * 100 : null;
    return `<button class="item" data-action="hist" data-id="${esc(h.id)}">${avatar(h.symbol, h.mint)}
      <div class="grow"><div style="font-weight:650">${esc(h.symbol)}</div><div class="small muted">${esc(h.reason)} · ${agoText(h.closedAt)}</div></div>
      <div class="val"><div class="${cls(pnl ?? 0)}" style="font-weight:700">${pp !== null ? pct(pp) : '?'}</div><div class="small">${pnl !== null ? signed(pnl) + ' SOL' : 'unknown'}</div></div></button>`;
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
        ${sw('skipMayhem', 'Skip "mayhem mode" coins', 'Coins with pump.fun’s trading agent')}
        <button class="item" data-action="reset-rules"><div class="grow" style="color:var(--blue)">Use the style's defaults</div></button>
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
    set('set-practice', solNum(toSol(b.practice.balance)) + ' SOL');
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
      body = `<div class="hero"><div class="logo" role="img" aria-label="Win Bot"></div><h1>Win Bot</h1><p>A pump.fun trading bot that runs on your iPhone.</p></div>
        <div class="points">
          <div class="point"><span class="n">1</span><p><strong>Practice first</strong>It starts with pretend SOL on real live coins, so you can watch it work.</p></div>
          <div class="point"><span class="n">2</span><p><strong>It trades by simple rules</strong>Buys new coins that are rising fast with spread-out holders. Sells at your profit target, stop loss or time limit.</p></div>
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
          <div class="nums"><span>${v.tradeSol} SOL a trade</span><span>Take profit +${v.takeProfitPct}%</span><span>Stop loss −${v.stopLossPct}%</span><span>Max ${v.maxHoldMin} min</span></div></button>`).join('')}</div>`;
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
    if (['coin', 'pos', 'activity', 'deposit'].includes(this.sheet.kind)) this.renderSheet();
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
          <dt>Bot's view</dt><dd>${esc(data.error || c?.status || (c?.eval ? c.eval.reason : data.complete ? 'Graduated coins can be sold here, not bought' : 'Not checked'))}</dd>
          ${holders ? `<dt>Holders</dt><dd class="${holders.ok ? 'up' : 'down'}">${esc(holders.reason)}</dd>` : ''}
        </dl>
        <div class="section-title">Buy with ${mode === 'real' ? 'real SOL' : 'practice SOL'}</div>
        <div class="btn-row ${amounts.length === 3 ? 'three' : ''}" style="grid-template-columns:repeat(${amounts.length},1fr)">${amounts.map((a) => `<button class="btn mode" data-action="buy" data-mint="${esc(data.mint)}" data-sol="${a}" ${this.busyBuys.has(data.mint) || b.buying.has(data.mint) ? 'disabled' : ''}>${this.busyBuys.has(data.mint) || b.buying.has(data.mint) ? '…' : a}</button>`).join('')}</div>
        <p class="small muted">The bot then sells it by your rules (take profit, stop loss, time limit). ${mode === 'real' ? 'Uses SOL from the bot wallet.' : ''}</p>
        <div class="btn-row mt"><a class="btn" href="https://pump.fun/coin/${esc(data.mint)}" target="_blank" rel="noopener">pump.fun</a><button class="btn" data-action="copy" data-text="${esc(data.mint)}">Copy address</button></div>${close}`;
    } else if (kind === 'pos') {
      const p = b.positions.get(data.id);
      if (!p) { html = `<div class="empty"><b>This trade is closed</b>See the History tab for the result.</div>${close}`; }
      else html = this.posCard(p) + (p.buySig ? `<a class="btn ghost" href="https://solscan.io/tx/${esc(p.buySig)}" target="_blank" rel="noopener">View the buy on Solscan</a>` : '') + close;
    } else if (kind === 'hist') {
      const h = b.history.find((x) => x.id === data.id);
      if (!h) { this.closeSheet(); return; }
      html = `<div class="row">${avatar(h.symbol, h.mint)}<div><h2>${esc(h.name)}</h2><div class="muted">${esc(h.symbol)}</div></div></div>
        <dl class="kv mt"><dt>Result</dt><dd class="${cls(h.pnlLamports === null ? 0 : toSol(h.pnlLamports))}">${h.pnlLamports === null ? 'Unknown' : signed(toSol(h.pnlLamports)) + ' SOL'}</dd>
        <dt>Paid</dt><dd>${solNum(toSol(h.costLamports))} SOL</dd><dt>Got back</dt><dd>${h.proceedsLamports === null ? '–' : solNum(toSol(h.proceedsLamports)) + ' SOL'}</dd>
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
        <h3>What it does</h3><p>It watches every new coin launched on pump.fun. When a coin is rising fast, still early on its curve, and its coins are spread across many wallets, the bot buys a small amount. Then it sells when one of your rules hits: take profit, stop loss, trailing stop, the time limit, or just before the coin graduates.</p>
        <h3>Keep the app open</h3><p>iPhone pauses web apps in the background, so the bot only trades while Win Bot is open on screen. When it's running it keeps the screen on by itself; plug your phone in. If you leave and come back, it checks your trades right away and sells anything that hit a rule.</p>
        <h3>Practice vs real</h3><p>Practice uses pretend SOL with the same live coins and rules, with prices made 2% worse to be realistic. Real mode uses the SOL in your bot wallet.</p>
        <h3>Fees</h3><p>pump.fun charges about 1.25% per trade. Each trade also pays a small network fee (about 0.0001 to 0.0005 SOL depending on Speed). The first trade of each coin puts about 0.002 SOL into a token account; the bot gets it back after selling.</p>
        <h3>Safety</h3><p>Most pump.fun coins go to zero, and no bot wins every trade. Start in Practice, then use small amounts. The bot never sells coins it didn't buy unless you tap Sell. Every real trade is test-run on the network first and cancelled if it would move more SOL than expected.</p>
        <h3>If something goes wrong</h3><p>Your SOL is always in the bot wallet on Solana. With your backup key you can open it in Phantom from any device and sell or send anything there.</p></div>${close}`;
    }
    if (this.sheetRendered === kind + JSON.stringify(data)) patch(body, html);
    else { body.innerHTML = html; this.sheetRendered = kind + JSON.stringify(data); }
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
        case 'sell-all': {
          const ok = await this.confirm({ title: 'Sell everything now?', text: 'The bot sells every open trade at the current price.', ok: 'Sell all', danger: true });
          if (ok) b.sellAll();
          break;
        }
        case 'set': b.updateSettings({ [t.dataset.key]: t.dataset.value }); this.renderSettings(); break;
        case 'reset-rules': b.updateSettings({ tradeSol: null, maxOpen: null, takeProfitPct: null, stopLossPct: null, trailStartPct: null, trailDropPct: null, maxHoldMin: null, dailyLossSol: null }); this.renderSettings(); this.toast('Rules reset to the style defaults.'); break;
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
