// The bot: watches new pump.fun coins, buys the ones that pass its rules,
// and sells by its exit rules. Works the same in Practice (fake SOL, real
// live prices) and Real mode. All state is saved on the phone.

import { isAddress, b58encode } from './b58.js?v=2.4.0';
import { Keypair } from './keys.js?v=2.4.0';
import { associatedTokenAddress } from './pda.js?v=2.4.0';
import * as pump from './pump.js?v=2.4.0';
import { Rpc, ChainStream, normalizeRpcInput } from './rpc.js?v=2.4.0';
import { CoinFeed } from './feeds.js?v=2.4.0';
import { Trader, TradeError, readMeta } from './trader.js?v=2.4.0';
import { DEFAULT_SETTINGS, STYLES, resolveRules, migrateSettings, evaluateScan, evaluateHolders, evaluateExit, snapAt } from './strategy.js?v=2.4.0';
import { Tape, judge, fatalDuringStudy, flowSignals } from './analyst.js?v=2.4.0';
import { resolveWallet, walletActivityFromLogs } from './wallets.js?v=2.4.0';
import { fromBase64 } from './bytes.js?v=2.4.0';

const POLL_MS = 2500;
const MAX_WATCH = 99;
const MAX_STUDY = 8; // coins studied at the same time (each is a live trade subscription)
const MAX_WALLETS = 10;
const MIN_COPY_SOL = 0.01; // a copy smaller than this isn't worth the fees
// Raydium's main SOL/USDC pool: the SOL price straight from the chain, through your own data key
const RAYDIUM_SOL_USDC = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const COIN_TTL_MS = 20 * 60_000;
const MAX_COINS = 400;
const FEE_BUFFER_SOL = 0.006; // token account rent + network fees for one trade
const PRACTICE_FEE = 100_000n; // simulated network + priority fee per practice trade
const PRACTICE_SLIPPAGE = 98n; // practice fills get 2% worse prices, like a real busy market

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (a) => (a ? a.slice(0, 4) + '…' + a.slice(-4) : '');
function dayKey(t) { const d = new Date(t); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }

function normalizeWallet(w) {
  const copySol = Number(w.copySol);
  return {
    address: w.address,
    username: typeof w.username === 'string' ? w.username.slice(0, 32) : null,
    label: typeof w.label === 'string' ? w.label.slice(0, 24) : null,
    addedAt: w.addedAt || Date.now(),
    copy: !!w.copy,
    copySol: copySol > 0 ? Math.min(100, copySol) : 0.05,
    minLeaderSol: Number(w.minLeaderSol) > 0 ? Number(w.minLeaderSol) : 0.01,
    trades: Array.isArray(w.trades) ? w.trades.slice(0, 40) : [],
    holdings: w.holdings && typeof w.holdings === 'object' ? w.holdings : {},
    lastTradeAt: w.lastTradeAt || 0,
    seen: new Set(Array.isArray(w.seenList) ? w.seenList : []),
    balance: null,
  };
}

export class Bot extends EventTarget {
  constructor({ store, fetchImpl, WebSocketImpl, now, timing } = {}) {
    super();
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.now = now || (() => Date.now());
    this.timing = timing;
    this.wallet = null;
    this.rpc = null;
    this.trader = null;
    this.feed = null;
    this.running = false;
    this.coins = new Map();
    this.positions = new Map();
    this.history = [];
    this.activity = [];
    this.pending = [];
    this.bought = new Set();
    this.lanes = { buy: { jobs: [], busy: false }, sell: { jobs: [], busy: false } };
    this.balance = null;
    this.solUsd = null;
    this.alerts = new Map();
    this.feedStatus = { chain: 'off', pumpportal: 'off' };
    this.lastPollAt = 0;
    this.lastBuyAt = 0;
    this.failStreak = 0;
    this.pausedReason = null;
    this.entryBlock = null;
    this.buyInFlight = false;
    this.loopTimer = null;
    this.poolCache = new Map();
    this.buying = new Set();
    this.pollMs = timing?.botPollMs ?? POLL_MS;
    this.stream = null;
    this.streamStatus = 'off';
    this.watches = new Map(); // address -> { unsub, kind, mint|address }
    this.tapes = new Map(); // mint -> Tape (live trades)
    this.wallets = [];
    this.metaCache = new Map();
    this.pipeline = { scanned: 0, studied: 0, passed: 0, rejected: 0, bought: 0 };
    this.lossStreak = { practice: 0, real: 0 };
    this.agentAddr = null;
  }

  // ---------- setup & persistence ----------

  async init() {
    this.settings = { ...DEFAULT_SETTINGS, rpcInput: '', backupDone: false, setupDone: false, ...migrateSettings(this.store.load('settings', {}) || {}) };
    this.agentAddr = await pump.mayhemAgentAddress();
    const secret = this.store.load('wallet', null);
    if (secret) {
      try { this.wallet = await Keypair.fromSecretText(secret); }
      catch { this._alert('wallet', 'error', "The saved wallet couldn't be read. Import your backup key in Settings."); }
    }
    const st = this.store.load('state', {});
    for (const p of st.positions || []) { p.state = 'open'; p.nextSellAt = 0; this.positions.set(p.id, p); }
    this.history = st.history || [];
    this.practice = st.practice || { balance: pump.solToLamports(this.settings.practiceStartSol) };
    this.daily = st.daily || { day: dayKey(this.now()), real: 0n, practice: 0n };
    this.pending = st.pending || [];
    this.bought = new Set(st.bought || []);
    this.wasRunning = !!st.running;
    // reopened by the app's own updater a moment ago: carry on where it left off
    const resume = this.store.load('resumeAfterUpdate', null);
    if (resume) this.store.save('resumeAfterUpdate', null);
    this.resumeAfterUpdate = !!(resume && st.running && Date.now() - resume.at < 90_000);
    this.activity = st.activity || [];
    this.lossStreak = st.lossStreak || { practice: 0, real: 0 };
    this.wallets = (this.store.load('wallets', []) || []).filter((w) => w && isAddress(w.address)).map(normalizeWallet);
    this._connect();
    if (this.rpc && this.wallet) {
      this.refreshBalance().catch(() => {});
      this.reconcile().catch(() => {});
    }
    const lastPrice = this.store.load('solUsd', null);
    if (lastPrice && lastPrice.v > 0 && Date.now() - lastPrice.at < 24 * 3600_000) { this.solUsd = lastPrice.v; this._applyPendingPractice(); }
    this.refreshSolPrice();
    this.priceTimer = setInterval(() => this.refreshSolPrice(), 2 * 60_000);
    this._syncWatches();
    if (this.rpc) for (const w of this.wallets) this.refreshWallet(w.address).catch(() => {});
    this._ensureLoop();
    this._emit();
  }

  _save() {
    this.store.save('settings', this.settings);
    const positions = [...this.positions.values()].map(({ curve, liveCurve, ...p }) => p);
    this.store.save('state', {
      positions, history: this.history.slice(0, 300), practice: this.practice, daily: this.daily,
      pending: this.pending, bought: [...this.bought].slice(-500), running: this.running, activity: this.activity.slice(0, 80),
      lossStreak: this.lossStreak,
    });
  }

  _saveWallets() {
    this.store.save('wallets', this.wallets.map(({ seen, balance, loading, ...w }) => ({ ...w, seenList: [...(seen || [])].slice(-60) })));
  }

  _emit() {
    if (this._emitQueued) return;
    this._emitQueued = true;
    queueMicrotask(() => { this._emitQueued = false; this.dispatchEvent(new Event('change')); });
  }

  log(level, message, extra = {}) {
    this.activity.unshift({ t: this.now(), level, message, ...extra });
    if (this.activity.length > 120) this.activity.length = 120;
    this._emit();
  }

  _alert(key, level, message) { this.alerts.set(key, { level, message, t: this.now() }); this._emit(); }
  _clearAlert(key) { if (this.alerts.delete(key)) this._emit(); }

  rules() { return resolveRules(this.settings); }

  updateSettings(patch) {
    const before = this.settings.rpcInput;
    this.settings = { ...this.settings, ...patch };
    if (patch.rpcInput !== undefined && patch.rpcInput !== before) {
      this.feed?.stop();
      this.feed = null;
      this._connect();
      if (this.running) this._startFeed();
      this._syncWatches();
    }
    this._save();
    this._emit();
  }

  _connect() {
    const n = normalizeRpcInput(this.settings.rpcInput);
    this.rpcInfo = n;
    this.rpc = n ? new Rpc(n.http, { fetchImpl: this.fetchImpl, maxPerSecond: 8 }) : null;
    // one live connection for everything: new coins, studied coins, held coins, tracked wallets
    const old = this.stream;
    this.watches.clear();
    this.stream = n?.ws ? new ChainStream(n.ws, { WebSocketImpl: this.WebSocketImpl, onStatus: (st) => { this.streamStatus = st; this._emit(); } }) : null;
    old?.stop();
    this.trader = this.rpc && this.wallet ? new Trader({
      rpc: this.rpc, wallet: this.wallet, fetchImpl: this.fetchImpl, timing: this.timing,
      log: (lvl, msg) => this.log(lvl, msg),
      onPending: (p) => { this.pending.push(p); this._save(); },
      onSettled: (sig, uncertain) => { if (!uncertain) { this.pending = this.pending.filter((x) => x.sig !== sig); this._save(); } },
    }) : null;
  }

  /** Check a data key / RPC URL before saving it. */
  async testConnection(input) {
    const n = normalizeRpcInput(input);
    if (!n) return { ok: false, message: "That doesn't look like a Helius key or an https:// Solana address." };
    const rpc = new Rpc(n.http, { fetchImpl: this.fetchImpl });
    try {
      const r = await rpc.call('getLatestBlockhash', [{ commitment: 'confirmed' }], { retries: 1, timeoutMs: 10000 });
      if (!r?.value?.blockhash) throw new Error('bad reply');
      return { ok: true, message: 'Connected to Solana through ' + n.label + '.' };
    } catch (e) {
      return { ok: false, message: e.status === 401 || e.status === 403 ? 'That key was refused. Copy it again from your Helius dashboard.' : (e.message || 'Could not connect.') };
    }
  }

  /** Refuse to replace a wallet that still holds SOL or coins (checked fresh, not from memory). */
  async _assertReplaceable({ confirmedBackup = false } = {}) {
    if (!this.wallet) return;
    if ([...this.positions.values()].some((p) => p.mode === 'real')) throw new Error('This wallet still holds coins. Sell them first.');
    try {
      const bal = await this.refreshBalance();
      if (bal === null) throw new Error('no connection');
      if (bal > 1_000_000n) throw Object.assign(new Error(`This wallet still holds ${pump.lamportsToSol(bal).toFixed(4)} SOL. Send it to Phantom first, or back up its key.`), { holdsFunds: true });
    } catch (e) {
      if (e.holdsFunds) throw e; // never replace a wallet that holds SOL
      if (!confirmedBackup) throw new Error("Couldn't check the current wallet's balance. Back up its key first (Settings → Show backup key), then try again.");
    }
  }

  async createWallet(opts = {}) {
    await this._assertReplaceable(opts);
    this.wallet = await Keypair.generate();
    this.store.save('wallet', this.wallet.exportSecret());
    this.settings.backupDone = false;
    this._afterWalletChange();
    return this.wallet.address;
  }

  async importWallet(text, opts = {}) {
    const kp = await Keypair.fromSecretText(text);
    if (this.wallet && kp.address === this.wallet.address) return kp.address;
    await this._assertReplaceable(opts);
    this.wallet = kp;
    this.store.save('wallet', kp.exportSecret());
    this.settings.backupDone = true;
    this._afterWalletChange();
    return kp.address;
  }

  _afterWalletChange() {
    for (const [id, p] of this.positions) if (p.mode === 'real') this.positions.delete(id);
    this.pending = [];
    this.balance = null;
    this._clearAlert('wallet');
    this._connect();
    this._save();
    if (this.rpc) { this.refreshBalance().catch(() => {}); this.reconcile().catch(() => {}); }
    this._emit();
  }


  exportSecret() { return this.wallet ? this.wallet.exportSecret() : null; }

  resetPractice() {
    for (const [id, p] of this.positions) if (p.mode === 'practice') this.positions.delete(id);
    this.practice = { balance: pump.solToLamports(this.settings.practiceStartSol) };
    this.history = this.history.filter((h) => h.mode !== 'practice');
    this.daily.practice = 0n;
    for (const k of [...this.bought]) if (k.startsWith('practice:')) this.bought.delete(k);
    this._save();
    this._emit();
  }

  /** Stop every timer and connection (used before erasing, and by tests). */
  dispose() {
    this.running = false;
    this.feed?.stop();
    this.feed = null;
    this.stream?.stop();
    this.watches.clear();
    clearInterval(this.priceTimer);
    clearTimeout(this.loopTimer);
    this.loopTimer = null;
    this.disposed = true;
  }

  eraseEverything() {
    this.stop();
    clearInterval(this.priceTimer);
    this.store.clearAll();
  }

  // ---------- money ----------

  async refreshBalance() {
    if (!this.rpc || !this.wallet) return null;
    const r = await this.rpc.call('getBalance', [this.wallet.address, { commitment: 'confirmed' }]);
    this.balance = BigInt(r.value);
    this._emit();
    return this.balance;
  }

  async refreshSolPrice() {
    const f = this.fetchImpl || ((...a) => globalThis.fetch(...a));
    const getJson = async (url) => {
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = setTimeout(() => ctrl?.abort(), 6000);
      try { const r = await f(url, { signal: ctrl?.signal }); if (!r.ok) throw new Error('http ' + r.status); return await r.json(); }
      finally { clearTimeout(timer); }
    };
    const sources = [
      async () => (await getJson('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd'))?.solana?.usd,
      () => this._onChainSolPrice(),
      async () => (await getJson('https://api.coinbase.com/v2/prices/SOL-USD/spot'))?.data?.amount,
      async () => { const j = await getJson('https://api.kraken.com/0/public/Ticker?pair=SOLUSD'); const k = j?.result && Object.keys(j.result)[0]; return k ? j.result[k]?.c?.[0] : null; },
      async () => (await getJson('https://lite-api.jup.ag/price/v3?ids=' + pump.WSOL))?.[pump.WSOL]?.usdPrice,
    ];
    for (const src of sources) {
      try {
        const v = Number(await src());
        if (v > 1 && v < 100000) {
          this.solUsd = v;
          this.solUsdAt = Date.now();
          this.store.save('solUsd', { v, at: this.solUsdAt });
          this._applyPendingPractice();
          this._emit();
          return v;
        }
      } catch { /* try the next source */ }
    }
    return null; // keep the last known price
  }

  /** SOL price from Raydium's SOL/USDC pool (checked: the vaults must hold SOL and USDC). */
  async _onChainSolPrice() {
    if (!this.rpc) return null;
    if (!this.solPool) {
      const r = await this.rpc.call('getMultipleAccounts', [[RAYDIUM_SOL_USDC], { encoding: 'base64', commitment: 'confirmed' }], { retries: 0 });
      const a = r?.value?.[0];
      if (!a) return null;
      const d = fromBase64(a.data[0]);
      if (d.length < 464 || b58encode(d.subarray(400, 432)) !== pump.WSOL || b58encode(d.subarray(432, 464)) !== USDC_MINT) return null;
      this.solPool = { baseVault: b58encode(d.subarray(336, 368)), quoteVault: b58encode(d.subarray(368, 400)) };
    }
    const r = await this.rpc.call('getMultipleAccounts', [[this.solPool.baseVault, this.solPool.quoteVault], { encoding: 'base64', commitment: 'confirmed' }], { retries: 0 });
    const [b, q] = (r?.value || []).map((x) => (x ? pump.decodeTokenAccount(fromBase64(x.data[0])) : null));
    if (!b || !q || b.mint !== pump.WSOL || q.mint !== USDC_MINT || b.amount <= 0n) return null;
    return (Number(q.amount) / 1e6) / (Number(b.amount) / 1e9);
  }

  /** Add pretend money to the practice balance, in dollars at the live SOL price. */
  addPracticeUsd(usd) {
    const n = Number(usd);
    if (!(n > 0) || n > 1_000_000) throw new Error('Pick an amount to add.');
    if (!(this.solUsd > 0)) throw new Error("Couldn't get the SOL price yet. Try again in a moment.");
    const lamports = pump.solToLamports(n / this.solUsd);
    this.practice.balance = BigInt(this.practice.balance) + lamports;
    this.log('info', `Added $${n.toLocaleString('en-US')} (${pump.lamportsToSol(lamports).toFixed(3)} SOL) to your practice balance.`);
    this._save();
    this._emit();
    return lamports;
  }

  _applyPendingPractice() {
    const usd = Number(this.settings.pendingPracticeUsd) || 0;
    if (!(usd > 0) || !(this.solUsd > 0)) return;
    this.settings.pendingPracticeUsd = 0;
    this.addPracticeUsd(usd);
  }

  availableLamports(mode = this.settings.mode) {
    return mode === 'practice' ? this.practice.balance : (this.balance ?? 0n);
  }

  _rollDay() {
    const k = dayKey(this.now());
    if (this.daily.day !== k) this.daily = { day: k, real: 0n, practice: 0n };
  }

  // ---------- start / stop ----------

  canStart() {
    if (!this.wallet) return { ok: false, message: 'Set up your bot wallet first.' };
    if (!this.rpc) return { ok: false, message: 'Add your free data key in Settings first.' };
    const rules = this.rules();
    if (this.settings.mode === 'real') {
      const need = rules.tradeSol + rules.keepSolReserve + FEE_BUFFER_SOL;
      const have = pump.lamportsToSol(this.balance ?? 0n);
      if (have < need) return { ok: false, message: `Add SOL to the bot wallet first. One ${rules.tradeSol} SOL trade needs about ${need.toFixed(3)} SOL with fees; it has ${have.toFixed(3)}.` };
    } else if (pump.lamportsToSol(this.practice.balance) < rules.tradeSol + 0.001) {
      return { ok: false, message: 'Your practice balance is too low. Reset it in Settings.' };
    }
    return { ok: true };
  }

  async start() {
    if (this.running) return;
    if (this.settings.mode === 'real') await this.refreshBalance().catch(() => {});
    const c = this.canStart();
    if (!c.ok) throw new Error(c.message);
    this.running = true;
    this.wasRunning = false;
    this.pausedReason = null;
    this.failStreak = 0;
    this.pipeline = { scanned: 0, studied: 0, passed: 0, rejected: 0, bought: 0 };
    this._startFeed();
    this._syncWatches();
    this._ensureLoop();
    const s = STYLES[this.settings.style]?.label || 'Balanced';
    this.log('info', `Bot started: ${this.settings.mode === 'real' ? 'REAL money' : 'Practice'}, ${s} style.`);
    this._save();
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.feed?.stop();
    this.feed = null;
    this.feedStatus = { chain: 'off', pumpportal: 'off' };
    for (const c of this.coins.values()) if (c.stage === 'study' || c.stage === 'passed') { c.stage = 'scan'; c.status = null; }
    this._syncWatches();
    this.log('info', 'Bot stopped. It still watches open trades until they are sold.');
    this._save();
  }

  resume() {
    this.pausedReason = null;
    this.failStreak = 0;
    this._clearAlert('paused');
    this._emit();
  }

  _startFeed() {
    if (this.feed) return;
    this.feed = new CoinFeed({
      stream: this.stream,
      WebSocketImpl: this.WebSocketImpl,
      onStatus: (s) => { this.feedStatus = { ...s }; this._emit(); },
      onCoin: (c) => this._addCoin(c),
    });
    this.feed.start();
  }

  /** Called when the app comes back to the screen. */
  async onResume(hiddenMs) {
    if (hiddenMs > 20000) {
      // iOS froze the app: the live connection is probably dead, so open a fresh one
      this.stream?._reconnect();
      if (this.running) { this.feed?.portal?.stop(); this.feed?.portal?.start(); }
    }
    if (hiddenMs > 5000) for (const w of this.wallets) this.refreshWallet(w.address).catch(() => {});
    clearTimeout(this.loopTimer);
    this.loopTimer = null;
    this._ensureLoop();
    if (this.rpc && this.wallet) {
      this.refreshBalance().catch(() => {});
      this.reconcile().catch(() => {});
    }
  }

  // ---------- coins ----------

  async _addCoin(c) {
    const existing = this.coins.get(c.mint);
    if (existing) {
      // the second feed reported it too: fill in anything the first one didn't know
      for (const k of ['creator', 'tokenProgram', 'isMayhemMode', 'devBuySol', 'devBuyTokens', 'createSig']) {
        if ((existing[k] === null || existing[k] === undefined) && c[k] !== null && c[k] !== undefined) existing[k] = c[k];
      }
      this.tapes.get(c.mint)?.setCreator(existing.creator);
      return;
    }
    if (c.update) return;
    const coin = { ...c, curveAddr: null, snaps: [], curve: null, verdict: null, scan: null, holders: null, holderCheckedAt: 0, watching: true, stage: 'scan', studies: 0 };
    delete coin.update;
    this.coins.set(c.mint, coin);
    this.pipeline.scanned++;
    coin.curveAddr = await pump.bondingCurveAddress(c.mint);
    if (this.coins.size > MAX_COINS) this._pruneCoins(this.now(), true);
    this._emit();
  }

  _pruneCoins(now, force = false) {
    const held = new Set([...this.positions.values()].map((p) => p.mint));
    const keep = (c) => held.has(c.mint) || c.stage === 'study' || c.stage === 'passed';
    for (const [m, c] of this.coins) {
      if (keep(c)) continue;
      if (now - c.createdAt > COIN_TTL_MS) this.coins.delete(m);
    }
    if (force && this.coins.size > MAX_COINS) {
      const old = [...this.coins.values()].filter((c) => !keep(c)).sort((a, b) => a.createdAt - b.createdAt);
      for (const c of old.slice(0, this.coins.size - MAX_COINS)) this.coins.delete(c.mint);
    }
  }

  _coinsToWatch(now, capacity) {
    const maxAge = this.rules().entry.maxAgeMin * 60_000;
    const live = [...this.coins.values()].filter((c) => c.curveAddr && (c.stage === 'study' || c.stage === 'passed'));
    const list = [...this.coins.values()].filter((c) => c.curveAddr && c.watching && c.stage !== 'study' && c.stage !== 'passed' && now - c.createdAt <= maxAge);
    // the newest coins first, then the ones with money coming in
    const young = list.filter((c) => now - c.createdAt < 90_000).sort((a, b) => b.createdAt - a.createdAt);
    const rest = list.filter((c) => now - c.createdAt >= 90_000).sort((a, b) => (b.solRaised || 0) - (a.solRaised || 0));
    return [...live, ...young, ...rest].slice(0, Math.max(0, capacity));
  }

  _openPositions(mode = null) {
    return [...this.positions.values()].filter((p) => !mode || p.mode === mode);
  }

  /** Being pickier after losses in a row: extra points the score needs. */
  pickiness(mode = this.settings.mode) {
    return Math.min(15, (this.lossStreak?.[mode] || 0) * 4);
  }

  // ---------- live trades (one subscription per address) ----------

  _tape(mint) {
    let t = this.tapes.get(mint);
    if (!t) {
      const c = this.coins.get(mint);
      const p = this.positions.get('real:' + mint) || this.positions.get('practice:' + mint);
      t = new Tape({ mint, creator: c?.creator || p?.creator || null, ignore: [this.wallet?.address, this.agentAddr] });
      this.tapes.set(mint, t);
    }
    return t;
  }

  /** Subscribe to exactly what's needed right now: studied coins, held coins, tracked wallets. */
  _syncWatches() {
    if (!this.stream || this.disposed) return;
    const want = new Map();
    for (const p of this.positions.values()) if (p.curveAddr && !p.complete) want.set(p.curveAddr, { kind: 'curve', mint: p.mint });
    for (const c of this.coins.values()) if ((c.stage === 'study' || c.stage === 'passed') && c.curveAddr) want.set(c.curveAddr, { kind: 'curve', mint: c.mint });
    for (const w of this.wallets) want.set(w.address, { kind: 'wallet', address: w.address });
    for (const [addr, h] of this.watches) {
      if (want.has(addr)) continue;
      h.unsub();
      this.watches.delete(addr);
      if (h.kind === 'curve' && ![...this.positions.values()].some((p) => p.mint === h.mint)) this.tapes.delete(h.mint);
    }
    for (const [addr, info] of want) {
      if (this.watches.has(addr)) continue;
      const handler = info.kind === 'curve' ? (sig, logs) => this._onCurveLogs(info.mint, sig, logs) : (sig, logs) => this._onWalletLogs(info.address, sig, logs);
      // tracked wallets: hear about their trades the moment they're processed, to copy them as fast as possible
      this.watches.set(addr, { ...info, unsub: this.stream.subscribe(addr, handler, { commitment: info.kind === 'wallet' ? 'processed' : 'confirmed' }) });
    }
    const needed = this.running || want.size > 0;
    if (needed && this.stream.stopped) this.stream.start();
    else if (!needed && !this.stream.stopped) this.stream.stop();
  }

  _onCurveLogs(mint, sig, logs) {
    const trades = pump.pumpEventsFromLogs(logs).trades.filter((t) => t.mint === mint);
    if (!trades.length) return;
    const now = this.now();
    const tape = this._tape(mint);
    for (const ev of trades) tape.add(ev, now, sig);
    const ev = trades[trades.length - 1];
    const curve = {
      virtualTokenReserves: ev.virtualTokenReserves, virtualQuoteReserves: ev.virtualSolReserves,
      realTokenReserves: ev.realTokenReserves, realQuoteReserves: ev.realSolReserves, complete: ev.realTokenReserves === 0n,
    };
    for (const mode of ['practice', 'real']) {
      const p = this.positions.get(mode + ':' + mint);
      if (!p || p.state === 'selling') continue;
      // value it from this exact trade, no waiting for the next price check
      if (!curve.complete) {
        p.liveCurve = curve;
        p.lastValueLamports = pump.curveSellLamportsOut(curve, BigInt(p.tokens));
        p.valuedAt = now;
        p.progress = pump.curveProgress(curve);
        if (BigInt(p.peakValueLamports || 0n) < p.lastValueLamports) p.peakValueLamports = p.lastValueLamports;
      }
      this._maybeExit(p, now);
    }
    const c = this.coins.get(mint);
    if (c) c.lastTradeAt = now;
    this._emit();
  }

  // ---------- main loop ----------

  _ensureLoop() {
    if (this.loopTimer) return;
    this.loopTimer = setTimeout(() => this._tick(), 0);
  }

  async _tick() {
    this.loopTimer = null;
    if (this.ticking || this.disposed) return;
    const needed = this.running || this.positions.size > 0;
    if (!needed || !this.rpc) return;
    this.ticking = true;
    try {
      await this._poll();
      this._clearAlert('rpc');
      // every 90 s, re-check the wallet itself (catches anything that changed outside the app)
      if (this.trader && this.now() - (this.lastReconcileAt || 0) > 90_000) {
        this.lastReconcileAt = this.now();
        this.reconcile().catch(() => {});
      }
    } catch (e) {
      if (this.rpc?.failStreak >= 3 || e?.status === 401 || e?.status === 403) {
        this._alert('rpc', 'error', e?.status === 429 ? 'Your free data plan is busy or used up. The bot is slowing down.' : 'Connection problem: ' + (e?.message || 'unknown'));
      }
    } finally {
      this.ticking = false;
    }
    if (!this.loopTimer && !this.disposed && (this.running || this.positions.size > 0)) {
      // back off when the connection is struggling (e.g. the free plan's rate limit)
      const slow = (this.rpc?.failStreak || 0) > 3 ? 4 : 1;
      this.loopTimer = setTimeout(() => this._tick(), this.pollMs * slow);
    }
  }

  async _poll() {
    const now = this.now();
    this._rollDay();
    this._pruneCoins(now);
    const positions = this._openPositions();
    const addrs = [];
    const seen = new Set();
    const add = (a) => { if (a && !seen.has(a) && addrs.length < 100) { seen.add(a); addrs.push(a); } };
    for (const p of positions) add(p.curveAddr);
    const watch = this.running ? this._coinsToWatch(now, MAX_WATCH - addrs.length) : [];
    for (const c of watch) add(c.curveAddr);
    // read each new coin's mint once to learn its token program and name
    const needMint = [...this.coins.values()].filter((c) => !c.tokenProgram && seen.has(c.curveAddr)).slice(0, Math.max(0, 100 - addrs.length));
    for (const c of needMint) add(c.mint);
    if (addrs.length) {
      const res = await this.rpc.call('getMultipleAccounts', [addrs, { encoding: 'base64', commitment: 'confirmed' }]);
      const byAddr = new Map();
      res.value.forEach((a, i) => { if (a) byAddr.set(addrs[i], { owner: a.owner, data: fromBase64(a.data[0]) }); });
      for (const c of needMint) {
        const m = byAddr.get(c.mint);
        if (m && (m.owner === pump.TOKEN || m.owner === pump.TOKEN_2022)) c.tokenProgram = m.owner;
      }
      const t = this.now();
      for (const c of watch) {
        const acc = byAddr.get(c.curveAddr);
        const curve = acc && acc.owner === pump.PUMP ? pump.decodeBondingCurve(acc.data) : null;
        if (!curve) continue;
        this._recordCurve(c, curve, t);
      }
      for (const p of positions) {
        const acc = byAddr.get(p.curveAddr);
        const curve = acc && acc.owner === pump.PUMP ? pump.decodeBondingCurve(acc.data) : null;
        await this._valuePosition(p, curve, t);
      }
      this.lastPollAt = t;
    }
    const t = this.now();
    for (const p of positions) this._maybeExit(p, t);
    if (this.running) {
      this._study(t);
      if (this.settings.autoBuy) this._maybeEnter(t);
    }
    this._syncWatches();
    this._emit();
  }

  _recordCurve(c, curve, t) {
    const mcap = pump.lamportsToSol(pump.curveMarketCapLamports(curve));
    const progress = pump.curveProgress(curve);
    const sol = pump.curveSolRaised(curve);
    const vsl = pump.curvePriceVsLaunch(curve);
    c.curve = { complete: curve.complete, isMayhemMode: curve.isMayhemMode, isCashbackCoin: curve.isCashbackCoin, solPaired: pump.isSolPaired(curve), depth: curve.depth, tokenTotalSupply: curve.tokenTotalSupply };
    if (c.isMayhemMode === null || c.isMayhemMode === undefined) c.isMayhemMode = curve.isMayhemMode;
    if (!c.creator || c.creator === pump.DEFAULT_PUBKEY) { c.creator = curve.creator; this.tapes.get(c.mint)?.setCreator(c.creator); }
    c.snaps.push({ t, mcap, progress, sol, vsl });
    if (c.snaps.length > 120) c.snaps.splice(0, c.snaps.length - 120);
    c.lastMcap = mcap;
    c.lastProgress = progress;
    c.solRaised = sol;
    c.vsLaunch = vsl;
    const peak = Math.max(...c.snaps.map((s) => s.mcap));
    // stop watching coins that died
    const age = t - c.createdAt;
    if (c.stage !== 'study' && c.stage !== 'passed' && ((age > 180_000 && sol < 0.5) || (age > 60_000 && mcap < peak * 0.4) || curve.complete)) c.watching = false;
  }

  async _valuePosition(p, curve, t) {
    if (curve) {
      p.complete = curve.complete;
      p.progress = pump.curveProgress(curve);
      p.mcapSol = pump.lamportsToSol(pump.curveMarketCapLamports(curve));
      if (!p.creator && curve.creator !== pump.DEFAULT_PUBKEY) { p.creator = curve.creator; this.tapes.get(p.mint)?.setCreator(p.creator); }
      if (p.mayhem === undefined) p.mayhem = curve.isMayhemMode;
      if (!curve.complete) {
        p.liveCurve = curve;
        p.lastValueLamports = pump.curveSellLamportsOut(curve, BigInt(p.tokens));
        p.valuedAt = t;
      }
    }
    if (p.complete) {
      const v = await this._poolValue(p.mint, BigInt(p.tokens), p.pool || null).catch(() => null);
      if (v !== null) { p.lastValueLamports = v; p.valuedAt = t; }
    }
    if (p.lastValueLamports !== undefined) {
      if (p.found && !(BigInt(p.costLamports) > 0n)) p.costLamports = p.lastValueLamports;
      if (BigInt(p.peakValueLamports || 0n) < BigInt(p.lastValueLamports)) p.peakValueLamports = p.lastValueLamports;
    }
  }

  async _poolValue(mint, tokens, poolAddr = null) {
    const pool = await this._readPool(mint, poolAddr);
    return pool ? pump.poolSellLamportsOut(pool.base, pool.quote, tokens) : null;
  }

  /** A coin's PumpSwap pool and live reserves (cached a few seconds). null if there isn't one. */
  async _readPool(mint, poolAddr = null) {
    const key = mint + '|' + (poolAddr || '');
    const hit = this.poolCache.get(key);
    if (hit && this.now() - hit.at < 4000) return hit;
    const addr = poolAddr || await pump.canonicalPoolAddress(mint);
    const r1 = await this.rpc.call('getMultipleAccounts', [[addr], { encoding: 'base64', commitment: 'confirmed' }]);
    const a = r1.value[0];
    const ps = a && a.owner === pump.PUMP_AMM ? pump.decodePool(fromBase64(a.data[0])) : null;
    if (!ps || ps.baseMint !== mint) return null;
    const r2 = await this.rpc.call('getMultipleAccounts', [[ps.poolBaseTokenAccount, ps.poolQuoteTokenAccount], { encoding: 'base64', commitment: 'confirmed' }]);
    const base = r2.value[0] ? pump.decodeTokenAccount(fromBase64(r2.value[0].data[0]))?.amount ?? 0n : 0n;
    const quote = (r2.value[1] ? pump.decodeTokenAccount(fromBase64(r2.value[1].data[0]))?.amount ?? 0n : 0n) + ps.virtualQuoteReserves;
    const pool = { addr, ps, base, quote, at: this.now() };
    this.poolCache.set(key, pool);
    if (this.poolCache.size > 200) this.poolCache.delete(this.poolCache.keys().next().value);
    return pool;
  }

  // ---------- studying coins ----------

  _judge(c, rules, now) {
    const last = c.snaps[c.snaps.length - 1];
    const recent = c.snaps.filter((x) => x.t >= now - 120_000);
    const peak = recent.length ? Math.max(...recent.map((x) => x.mcap)) : 0;
    // the last minute of price checks, so a short study still sees the bigger picture
    const ref = last ? snapAt(c.snaps, last.t - 60_000) : null;
    return judge({
      tape: this._tape(c.mint), studyStart: c.studyStart, studyMs: (c.studyEnd || now) - c.studyStart, now, coin: c, curve: c.curve || {},
      solRaised: last?.sol, vsLaunch: last?.vsl, progress: last?.progress, peakMcap2m: peak, mcap: last?.mcap,
      inflow60: last && ref && ref !== last ? last.sol - ref.sol : undefined,
      rise60: last && ref && ref !== last && ref.mcap > 0 ? last.mcap / ref.mcap - 1 : undefined,
      rules, pickiness: this.pickiness(), creatorSoldBefore: c.creatorSoldBefore,
    });
  }

  _reject(c, reason, now) {
    // keep the report honest: fresh numbers, and the real reason first
    if (c.studyStart && this.tapes.has(c.mint)) {
      try { c.verdict = this._judge(c, this.rules(), now); } catch { /* keep the last one */ }
    }
    if (c.verdict) c.verdict = { ...c.verdict, ok: false, reason, vetoes: [reason, ...c.verdict.vetoes.filter((x) => x !== reason)] };
    c.stage = 'rejected';
    c.rejectedAt = now;
    c.rejectSol = c.solRaised || 0;
    c.status = reason;
    if (/Creator/.test(reason)) c.noRestudy = true;
    this.pipeline.rejected++;
  }

  _canRestudy(c, now) {
    return !c.noRestudy && c.studies < 3 && now - (c.rejectedAt || 0) > 60_000 && (c.solRaised || 0) - (c.rejectSol || 0) >= 1.5;
  }

  _study(now) {
    const rules = this.rules();
    const mode = this.settings.mode;
    let studying = 0;
    for (const c of this.coins.values()) {
      if (c.stage === 'study') {
        const fatal = fatalDuringStudy(this._tape(c.mint), c.studyStart, now, c);
        if (fatal) { this._reject(c, fatal, now); continue; }
        c.verdict = this._judge(c, rules, now);
        if (now >= c.studyEnd) {
          if (c.verdict.ok) { c.stage = 'passed'; c.passedAt = now; c.status = c.verdict.reason; this.pipeline.passed++; }
          else this._reject(c, c.verdict.reason, now);
        } else { studying++; c.status = 'Studying'; }
      } else if (c.stage === 'passed' && now - c.passedAt > 20_000) {
        this._reject(c, 'Missed the moment', now);
      }
    }
    let slots = MAX_STUDY - studying;
    if (slots <= 0) return;
    const cands = [];
    for (const c of this.coins.values()) {
      if (!c.watching || !c.curve || !c.tokenProgram) continue;
      if (c.stage !== 'scan' && !(c.stage === 'rejected' && this._canRestudy(c, now))) continue;
      if (this.positions.has(mode + ':' + c.mint) || this.bought.has(mode + ':' + c.mint)) continue;
      c.scan = evaluateScan(c, rules, now);
      if (c.stage === 'scan') c.status = c.scan.ok ? null : c.scan.reason;
      if (c.scan.ok) cands.push(c);
    }
    cands.sort((a, b) => (b.scan.inflow20 || 0) - (a.scan.inflow20 || 0));
    for (const c of cands) {
      if (slots-- <= 0) break;
      const mayhem = !!(c.curve?.isMayhemMode || c.isMayhemMode);
      c.stage = 'study';
      c.studies++;
      c.studyStart = now;
      c.studyEnd = now + (mayhem ? rules.mayhemStudySec : rules.studySec) * 1000;
      c.verdict = null;
      c.status = 'Studying';
      this.pipeline.studied++;
    }
  }

  // ---------- buying ----------

  _maybeEnter(now) {
    const rules = this.rules();
    const mode = this.settings.mode;
    this.entryBlock = null;
    if (this.pausedReason) { this.entryBlock = this.pausedReason; return; }
    const mine = this._openPositions(mode).filter((p) => !p.found && !p.copiedFrom);
    if (mine.length >= rules.maxOpen) { this.entryBlock = `Holding ${mine.length} of ${rules.maxOpen} trades`; return; }
    this._clearAlert('daily'); // there's no daily loss limit anymore
    const needLamports = pump.solToLamports(rules.tradeSol + (mode === 'real' ? rules.keepSolReserve + FEE_BUFFER_SOL : 0.001));
    if (this.availableLamports(mode) < needLamports) { this.entryBlock = 'Not enough SOL for another trade'; return; }
    if (this.buyInFlight || now - this.lastBuyAt < 8000) return;
    const ready = [...this.coins.values()].filter((c) => c.stage === 'passed' && !this.positions.has(mode + ':' + c.mint) && !this.bought.has(mode + ':' + c.mint));
    if (!ready.length) return;
    // one last look with the newest numbers, right before buying
    for (const c of ready) {
      c.verdict = this._judge(c, rules, now);
      if (!c.verdict.ok) this._reject(c, c.verdict.reason, now);
    }
    const good = ready.filter((c) => c.stage === 'passed').sort((a, b) => b.verdict.score - a.verdict.score);
    if (good.length) this._checkAndBuy(good[0], rules);
  }

  async _checkAndBuy(coin, rules) {
    this.buyInFlight = true;
    coin.status = 'Checking holders';
    this._emit();
    try {
      const h = await this._holderCheck(coin, rules);
      coin.holders = h;
      coin.holderCheckedAt = this.now();
      if (!h.ok) { this._reject(coin, h.reason, this.now()); if (/Creator/.test(h.reason)) coin.noRestudy = true; return; }
      if (!this.running) return;
      coin.status = 'Buying';
      await this._buy(coin.mint, rules.tradeSol, 'auto', { mayhem: !!coin.curve?.isMayhemMode, score: coin.verdict?.score ?? null });
      coin.stage = 'bought';
      coin.status = 'Bought';
      this.pipeline.bought++;
    } catch (e) {
      coin.status = 'Buy failed';
      if (coin.stage === 'passed') coin.stage = 'rejected';
    } finally {
      this.buyInFlight = false;
      this._syncWatches();
      this._emit();
    }
  }

  async _holderCheck(coin, rules) {
    const r = await this.rpc.call('getTokenLargestAccounts', [coin.mint, { commitment: 'confirmed' }]);
    const holders = (r.value || []).map((h) => ({ address: h.address, amount: BigInt(h.amount) }));
    const curveAta = await associatedTokenAddress(coin.curveAddr, coin.mint, coin.tokenProgram);
    const agentAta = this.agentAddr ? await associatedTokenAddress(this.agentAddr, coin.mint, coin.tokenProgram) : null;
    const devAta = coin.creator && coin.creator !== pump.DEFAULT_PUBKEY ? await associatedTokenAddress(coin.creator, coin.mint, coin.tokenProgram) : null;
    return evaluateHolders({
      holders, supply: coin.curve?.tokenTotalSupply || 1_000_000_000_000_000n, excludeAddresses: [curveAta, agentAta],
      devAccount: devAta, devBought: coin.devBuyTokens ? BigInt(coin.devBuyTokens) : null,
    }, rules);
  }

  /** Buy now, from the bot (auto) or from a tap (manual). */
  async manualBuy(mint, sol) {
    mint = String(mint || '').trim();
    if (!isAddress(mint)) throw new Error("That isn't a valid coin address.");
    const amount = Number(sol);
    if (!(amount > 0)) throw new Error('Enter how much SOL to spend.');
    if (!this.wallet || !this.rpc) throw new Error('Finish setup first (wallet and data key).');
    const mode = this.settings.mode;
    if (this.buying.has(mint)) throw new Error('Already buying this coin.');
    if (this.positions.has(mode + ':' + mint)) throw new Error('You already hold this coin. Sell it first.');
    this.buying.add(mint); // claim it before anything async, so a double tap can't buy twice
    try {
      const rules = this.rules();
      const need = pump.solToLamports(amount + (mode === 'real' ? rules.keepSolReserve + FEE_BUFFER_SOL : 0.0001));
      if (mode === 'real') await this.refreshBalance().catch(() => {});
      if (this.availableLamports(mode) < need) throw new Error(`Not enough SOL. This needs about ${pump.lamportsToSol(need).toFixed(3)} SOL with fees.`);
      return await this._buy(mint, amount, 'manual');
    } finally {
      this.buying.delete(mint);
    }
  }

  async _buy(mint, sol, source, extra = {}, opts = {}) {
    const mode = this.settings.mode;
    const id = mode + ':' + mint;
    const rules = this.rules();
    const lamports = pump.solToLamports(sol);
    const coin = this.coins.get(mint);
    this.bought.add(id);
    this.buying.add(mint);
    this.lastBuyAt = this.now();
    let name = coin?.name, symbol = coin?.symbol;
    try {
      let pos;
      if (mode === 'practice') {
        const st = await this._readCoin(mint);
        const c = st.curve;
        const ranAway = (now) => new TradeError(opts.refPrice ? `the price is already up ${Math.round((now / opts.refPrice - 1) * 100)}% since they bought` : 'the price ran away', { kind: 'skipped' });
        let tokens, onPool = null;
        if (!c || c.complete || opts.pool) {
          // graduated: price it on its PumpSwap pool, like a real buy would
          const pl = await this._readPool(mint, opts.pool || null);
          if (!pl) throw new TradeError(c ? 'This coin is moving to PumpSwap right now. Try again in a moment.' : "This isn't a pump.fun coin.", { kind: c ? 'waiting' : 'unsupported' });
          if (pl.ps.quoteMint !== pump.WSOL || pl.ps.isCashbackCoin) throw new TradeError("This coin type can't be traded by the bot.", { kind: 'unsupported' });
          if (opts.maxPrice && pl.base > 0n) {
            const now = Number(pl.quote) / Number(pl.base);
            if (now > opts.maxPrice) throw ranAway(now);
          }
          tokens = (pump.poolBuyTokensOut(pl.base, pl.quote, lamports) * PRACTICE_SLIPPAGE) / 100n;
          onPool = pl;
        } else {
          if (!pump.isSolPaired(c) || c.isCashbackCoin) throw new TradeError("This coin type can't be traded by the bot.", { kind: 'unsupported' });
          if (opts.maxPrice && c.virtualTokenReserves > 0n) {
            const now = Number(c.virtualQuoteReserves) / Number(c.virtualTokenReserves);
            if (now > opts.maxPrice) throw ranAway(now);
          }
          tokens = (pump.curveBuyTokensOut(c, lamports) * PRACTICE_SLIPPAGE) / 100n;
        }
        if (tokens <= 0n) throw new TradeError('Nothing left to buy on this coin.', { kind: 'unsupported' });
        const cost = lamports + PRACTICE_FEE;
        if (this.practice.balance < cost) throw new TradeError('Not enough practice SOL.', { kind: 'funds' });
        this.practice.balance -= cost;
        opts.onSpent?.();
        name = name || st.meta?.name; symbol = symbol || st.meta?.symbol;
        pos = onPool
          ? { tokens, costLamports: cost, tokenProgram: st.tokenProgram, via: 'practice', buySig: null, mayhem: !!onPool.ps.isMayhemMode, creator: onPool.ps.coinCreator, onPool: true, complete: true, pool: onPool.addr }
          : { tokens, costLamports: cost, tokenProgram: st.tokenProgram, via: 'practice', buySig: null, mayhem: !!c.isMayhemMode, creator: c.creator };
      } else {
        const r = await this._queueTrade(() => this.trader.buy({ mint, lamports, slippagePct: rules.buySlippagePct, speed: rules.speed, maxPrice: opts.maxPrice || null, refPrice: opts.refPrice || null, pool: opts.pool || null }), 'buy');
        let tokens = r.tokDelta;
        if (tokens === null) {
          // landed, but the exact amounts couldn't be read: use the wallet's balance
          const held = (await this.trader.walletTokens().catch(() => [])).find((t) => t.mint === mint);
          tokens = held ? held.amount : null;
        }
        if (!(tokens > 0n)) throw Object.assign(new TradeError('The buy went through but the coins could not be found yet. The bot will pick them up on its next wallet check.', { kind: 'failed', sig: r.sig }), { sent: true, uncertain: true });
        if (!name) { const st = await this._readCoin(mint).catch(() => null); name = st?.meta?.name; symbol = st?.meta?.symbol; }
        // Cost = SOL that left the wallet, minus the refundable token-account deposit.
        // If that can't be read exactly, or looks wrong, use the amount spent.
        let cost = r.solDelta === null ? null : -r.solDelta - (r.rentDeposit || 0n);
        if (cost === null || cost < lamports / 2n || cost > lamports * 2n) cost = lamports + 100_000n;
        if (r.solDelta !== null && this.balance !== null && this.balance !== undefined) this.balance += r.solDelta; // until the refresh lands
        opts.onSpent?.();
        pos = { tokens, costLamports: cost, rentDeposit: r.rentDeposit || 0n, tokenProgram: r.tokenProgram, via: r.via, buySig: r.sig, ...(r.via === 'PumpSwap' ? { onPool: true, complete: true, pool: r.pool } : {}) };
        this.failStreak = 0;
        this.refreshBalance().catch(() => {});
      }
      const p = {
        id, mode, mint, name: name || 'Coin ' + short(mint), symbol: symbol || short(mint),
        curveAddr: await pump.bondingCurveAddress(mint), source, managed: true,
        openedAt: this.now(), peakValueLamports: 0n, lastValueLamports: undefined, state: 'open', sellAttempts: 0, nextSellAt: 0,
        creator: coin?.creator || null,
        ...pos, ...extra,
      };
      const existing = this.positions.get(id);
      if (existing) {
        // never overwrite: add to what's already held
        existing.tokens = BigInt(existing.tokens) + BigInt(p.tokens);
        existing.costLamports = BigInt(existing.costLamports || 0n) + BigInt(p.costLamports);
      } else {
        this.positions.set(id, p);
      }
      if (coin) coin.status = 'Bought';
      try { const held = this.positions.get(id) || p; await this._valuePosition(held, held.onPool ? null : (await this._readCoin(mint)).curve, this.now()); } catch { /* valued on the next check */ }
      const why = source === 'copy' ? ` (copying ${this.walletLabel(extra.copiedFrom)})` : extra.score !== undefined && extra.score !== null ? ` (score ${extra.score})` : '';
      this.log('buy', `Bought ${p.symbol} for ${sol} SOL${why}${mode === 'practice' ? ' (practice)' : ''}.`, { mint, sig: p.buySig });
      this._save();
      this._syncWatches();
      this._ensureLoop();
      return p;
    } catch (e) {
      // Allow another try only when we know nothing was bought.
      // ('expired' is not on this list: a lagging node could have hidden a buy that did land)
      const nothingBought = !e?.uncertain && ((e?.name === 'RpcError' && !e?.sent) || (e instanceof TradeError && (e.kind === 'slippage' || e.kind === 'skipped' || (e.kind === 'network' && !e.sent))));
      if (nothingBought) this.bought.delete(id);
      if (e?.kind === 'skipped') throw e; // a deliberate skip (copy trading), not a failure
      if (mode === 'real' && source === 'auto' && e?.kind !== 'unsupported') {
        this.failStreak++;
        if (this.failStreak >= 3) {
          this.pausedReason = 'Paused after 3 failed buys';
          this._alert('paused', 'error', 'Buying paused after 3 failed buys in a row. Check the activity list, then tap Resume.');
        }
      }
      this.log('error', `Couldn't buy ${symbol || short(mint)}: ${e.message}`, { mint, sig: e.sig || null });
      this._save();
      throw e;
    } finally {
      this.buying.delete(mint);
    }
  }

  /** Name, market cap and progress of any coin (for a pasted address). */
  async lookupCoin(mint) {
    if (!isAddress(mint)) throw new Error("That isn't a coin address.");
    const st = await this._readCoin(mint);
    if (!st.curve) throw new Error("This isn't a pump.fun coin (or it's very old).");
    return {
      name: st.meta?.name, symbol: st.meta?.symbol,
      mcap: pump.lamportsToSol(pump.curveMarketCapLamports(st.curve)),
      progress: pump.curveProgress(st.curve), complete: st.curve.complete,
    };
  }

  async _readCoin(mint) {
    const curveAddr = await pump.bondingCurveAddress(mint);
    const r = await this.rpc.call('getMultipleAccounts', [[curveAddr, mint], { encoding: 'base64', commitment: 'confirmed' }]);
    const [ca, ma] = r.value;
    if (!ma) throw new TradeError("That coin address doesn't exist on Solana.", { kind: 'unsupported' });
    const mintData = fromBase64(ma.data[0]);
    const curve = ca && ca.owner === pump.PUMP ? pump.decodeBondingCurve(fromBase64(ca.data[0])) : null;
    return { curve, tokenProgram: ma.owner, meta: pump.decodeToken2022Metadata(mintData) };
  }

  // ---------- selling ----------

  _maybeExit(p, now) {
    if (p.state === 'selling') return;
    if (p.nextSellAt && now < p.nextSellAt) return;
    if (p.sellRequested) { this._sell(p, p.sellRequested); return; }
    if (!p.managed || p.lastValueLamports === undefined) return;
    if (p.valuedAt && now - p.valuedAt > 20_000 && !p.complete) return; // stale price: don't act on it
    const tape = this.tapes.get(p.mint);
    const flow = tape ? flowSignals(tape, now, { since: p.openedAt }) : null;
    const d = evaluateExit(p, p.lastValueLamports, this.rules(), { progress: p.onPool ? 0 : p.progress ?? 0, complete: !!p.complete && !p.onPool, flow, solUsd: this.solUsd }, now);
    if (d.sell) this._sell(p, d.reason);
  }

  /** Sell part of a position by hand (fraction 0..1). */
  sellPart(id, fraction) {
    const p = this.positions.get(id);
    if (!p) return;
    if (fraction >= 0.9) { this.sellNow(id); return; }
    if (p.state === 'selling') throw new Error('This coin is already being sold. Try again in a moment.');
    this._sellPart(p, fraction, `You sold ${Math.round(fraction * 100)}%`);
  }

  /** " (+$1.23)" for a profit or loss in lamports, when the SOL price is known. */
  _usd(lamports) {
    if (lamports === null || lamports === undefined || !(this.solUsd > 0)) return '';
    const v = (Number(lamports) / 1e9) * this.solUsd;
    return ` (${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)})`;
  }

  /** Profit or loss right now on open trades (lamports), for the screen. */
  openPnl(mode = this.settings.mode) {
    let pnl = 0n;
    for (const p of this._openPositions(mode)) {
      if (p.lastValueLamports === undefined || p.found) continue;
      pnl += BigInt(p.lastValueLamports) - BigInt(p.costLamports || 0n);
    }
    return pnl;
  }

  sellNow(id) {
    const p = this.positions.get(id);
    if (!p) return;
    p.sellRequested = 'Sold by you';
    p.nextSellAt = 0;
    this._ensureLoop();
    if (p.state !== 'selling') this._sell(p, 'Sold by you');
  }

  sellAll() {
    for (const p of this.positions.values()) { p.sellRequested = 'Sell all'; p.nextSellAt = 0; if (p.state !== 'selling') this._sell(p, 'Sell all'); }
    this._ensureLoop();
  }

  async _sell(p, reason) {
    if (p.state === 'selling') return;
    p.state = 'selling';
    p.sellReason = reason;
    this._emit();
    const rules = this.rules();
    try {
      let proceeds, sig = null, via = 'practice';
      if (p.mode === 'practice') {
        let value = p.lastValueLamports;
        if (value === undefined) value = 0n;
        proceeds = (BigInt(value) * PRACTICE_SLIPPAGE) / 100n - PRACTICE_FEE;
        if (proceeds < 0n) proceeds = 0n;
        this.practice.balance += proceeds;
      } else {
        // more room for the price only after the price actually moved away from us
        const slip = Math.min(60, rules.sellSlippagePct + (p.slipSteps || 0) * 15);
        const r = await this._queueTrade(() => this.trader.sell({ mint: p.mint, tokenProgram: p.tokenProgram, amount: null, slippagePct: slip, speed: rules.speed, pool: p.pool || null }), 'sell');
        proceeds = r.solDelta;
        sig = r.sig;
        via = r.via;
        this._queueTrade(() => this.trader.closeEmptyTokenAccount(p.mint, p.tokenProgram), 'sell').then(() => this.refreshBalance()).catch(() => {});
        this.refreshBalance().catch(() => {});
      }
      this._close(p, { proceeds, reason, sig, via });
    } catch (e) {
      p.sellAttempts = (p.sellAttempts || 0) + 1;
      p.lastError = e.message;
      const now = this.now();
      if (e instanceof TradeError && e.kind === 'gone') {
        // Stay "selling" while we check, so nothing else closes it at the same time.
        const landed = await this._landedSell(p).catch(() => null);
        p.goneSeen = (p.goneSeen || 0) + 1;
        if (landed || p.goneSeen >= 2) {
          this._close(p, { proceeds: landed?.solDelta ?? null, reason: landed ? reason : 'Sold outside the bot', sig: landed?.sig || null, via: 'unknown' });
          return;
        }
        // one empty read can be a lagging node: look again shortly
        p.state = 'open';
        p.nextSellAt = now + 4000;
        this._save();
        this._ensureLoop();
        return;
      }
      p.state = 'open';
      p.goneSeen = 0;
      const kind = e?.kind;
      if (kind === 'slippage') { p.slipSteps = (p.slipSteps || 0) + 1; p.nextSellAt = now + 300; }
      else if (kind === 'waiting') p.nextSellAt = now + 5000;
      else if (kind === 'funds') {
        p.nextSellAt = now + 15000;
        this._alert('fees', 'error', 'The bot wallet needs a little SOL (0.005) to pay the network fee for selling. Send some from Phantom.');
      } else p.nextSellAt = now + Math.min(30000, 1500 * 2 ** Math.min(5, p.sellAttempts));
      this.log('error', `Couldn't sell ${p.symbol} yet: ${e.message} Trying again.`, { mint: p.mint, sig: e.sig || null });
      this._save();
      this._ensureLoop();
    }
  }

  _close(p, { proceeds, reason, sig, via }) {
    if (p.closed || this.positions.get(p.id) !== p) return; // already closed
    p.closed = true;
    this.positions.delete(p.id);
    const cost = BigInt(p.costLamports || 0n);
    const pnl = proceeds === null ? null : BigInt(proceeds) - cost;
    if (pnl !== null && !p.found) {
      this._rollDay();
      this.daily[p.mode] = (this.daily[p.mode] || 0n) + pnl;
      if (p.source === 'auto') this.lossStreak[p.mode] = pnl < 0n ? (this.lossStreak[p.mode] || 0) + 1 : 0;
    }
    this.history.unshift({
      id: p.id + ':' + this.now(), mode: p.mode, mint: p.mint, name: p.name, symbol: p.symbol,
      openedAt: p.openedAt, closedAt: this.now(), costLamports: cost, proceedsLamports: proceeds, pnlLamports: pnl,
      reason, buySig: p.buySig || null, sellSig: sig, via, found: !!p.found, source: p.source || null, copiedFrom: p.copiedFrom || null, score: p.score ?? null,
    });
    if (this.history.length > 300) this.history.length = 300;
    queueMicrotask(() => this._syncWatches());
    if (p.mode === 'real') this._clearAlert('fees');
    const pct = pnl !== null && cost > 0n ? (Number(pnl) / Number(cost)) * 100 : null;
    this.log(pnl !== null && pnl >= 0n ? 'win' : 'loss',
      `Sold ${p.symbol}${pct !== null ? ` ${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%` : ''}${this._usd(pnl)} (${reason})${p.mode === 'practice' ? ' (practice)' : ''}.`, { mint: p.mint, sig });
    this._save();
    this._emit();
  }

  /** Sell part of a position (copy trading: the wallet you copy sold part of theirs). */
  async _sellPart(p, fraction, reason) {
    if (p.state === 'selling' || p.closed) return;
    const tokens = BigInt(p.tokens);
    let amount = (tokens * BigInt(Math.round(Math.max(0, Math.min(1, fraction)) * 10000))) / 10000n;
    if (amount <= 0n) return;
    if (amount * 100n >= tokens * 90n) { this._sell(p, reason); return; }
    p.state = 'selling';
    p.sellReason = reason;
    this._emit();
    const rules = this.rules();
    try {
      let proceeds, sig = null, via = 'practice';
      if (p.mode === 'practice') {
        const value = p.liveCurve ? pump.curveSellLamportsOut(p.liveCurve, amount) : (BigInt(p.lastValueLamports ?? 0n) * amount) / tokens;
        proceeds = (value * PRACTICE_SLIPPAGE) / 100n - PRACTICE_FEE;
        if (proceeds < 0n) proceeds = 0n;
        this.practice.balance += proceeds;
      } else {
        const r = await this._queueTrade(() => this.trader.sell({ mint: p.mint, tokenProgram: p.tokenProgram, amount, slippagePct: rules.sellSlippagePct, speed: rules.speed, pool: p.pool || null }), 'sell');
        proceeds = r.solDelta;
        sig = r.sig;
        via = r.via;
        if (r.tokensSold > 0n && r.tokensSold <= tokens) amount = r.tokensSold;
        this.refreshBalance().catch(() => {});
      }
      const cost = BigInt(p.costLamports || 0n);
      const costPart = (cost * amount) / tokens;
      const left = tokens - amount;
      p.tokens = left;
      p.costLamports = cost - costPart;
      if (p.peakValueLamports) p.peakValueLamports = (BigInt(p.peakValueLamports) * left) / tokens;
      if (p.lastValueLamports !== undefined) p.lastValueLamports = (BigInt(p.lastValueLamports) * left) / tokens;
      const pnl = proceeds === null ? null : BigInt(proceeds) - costPart;
      if (pnl !== null) { this._rollDay(); this.daily[p.mode] = (this.daily[p.mode] || 0n) + pnl; }
      this.history.unshift({
        id: p.id + ':' + this.now() + ':part', mode: p.mode, mint: p.mint, name: p.name, symbol: p.symbol,
        openedAt: p.openedAt, closedAt: this.now(), costLamports: costPart, proceedsLamports: proceeds, pnlLamports: pnl,
        reason, buySig: p.buySig || null, sellSig: sig, via, found: false, partial: true, source: p.source || null, copiedFrom: p.copiedFrom || null,
      });
      const pct = pnl !== null && costPart > 0n ? (Number(pnl) / Number(costPart)) * 100 : null;
      this.log(pnl !== null && pnl >= 0n ? 'win' : 'loss', `Sold ${Math.round(fraction * 100)}% of ${p.symbol}${pct !== null ? ` ${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%` : ''}${this._usd(pnl)} (${reason})${p.mode === 'practice' ? ' (practice)' : ''}.`, { mint: p.mint, sig });
    } catch (e) {
      this.log('error', `Couldn't sell part of ${p.symbol}: ${e.message}`, { mint: p.mint, sig: e.sig || null });
    } finally {
      if (this.positions.get(p.id) === p && p.state === 'selling') p.state = 'open';
      this._save();
      this._emit();
    }
  }

  async _landedSell(p) {
    const sigs = this.pending.filter((x) => x.mint === p.mint && x.kind === 'sell').map((x) => x.sig);
    for (const sig of sigs) {
      const t = await this.rpc.call('getTransaction', [sig, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }]);
      if (t?.meta && !t.meta.err) {
        this.pending = this.pending.filter((x) => x.sig !== sig);
        return { sig, ...readMeta(t, this.wallet.address, null) };
      }
    }
    return null;
  }

  // ---------- trades run one at a time per lane; sells never wait behind a buy ----------

  _queueTrade(fn, lane = 'buy') {
    const L = this.lanes[lane];
    return new Promise((resolve, reject) => {
      L.jobs.push({ fn, resolve, reject });
      this._drain(L);
    });
  }

  async _drain(L) {
    if (L.busy) return;
    L.busy = true;
    try {
      while (L.jobs.length) {
        const job = L.jobs.shift();
        try { job.resolve(await job.fn()); } catch (e) { job.reject(e); }
      }
    } finally {
      L.busy = false;
    }
  }

  _tradesBusy() {
    return Object.values(this.lanes).some((L) => L.busy || L.jobs.length);
  }

  get draining() { return this._tradesBusy(); }

  // ---------- wallet ----------

  async withdraw(to, sol) {
    to = String(to || '').trim();
    if (!isAddress(to)) throw new Error("That isn't a Solana address. Copy your Phantom address again.");
    if (to === this.wallet?.address) throw new Error("That's the bot wallet itself. Paste your Phantom address.");
    const bal = await this.refreshBalance();
    let lamports = sol === 'max' ? bal - 2_000_000n : pump.solToLamports(sol);
    if (lamports <= 0n) throw new Error('There is nothing to withdraw.');
    if (lamports > bal - 1_000_000n) throw new Error('That is more than the wallet holds (keep about 0.001 SOL for the fee).');
    const r = await this._queueTrade(() => this.trader.withdraw({ to, lamports }), 'buy');
    this.log('info', `Sent ${pump.lamportsToSol(lamports).toFixed(4)} SOL to ${short(to)}.`, { sig: r.sig });
    await this.refreshBalance().catch(() => {});
    return r;
  }

  /** Re-check unconfirmed trades and adopt coins the wallet holds. */
  reconcile() {
    if (!this.trader) return Promise.resolve();
    if (!this.reconcileRun) this.reconcileRun = this._reconcile().finally(() => { this.reconcileRun = null; });
    return this.reconcileRun;
  }

  async _reconcile() {
    this.reconciling = true;
    try {
      const now = this.now();
      if (this.pending.length) {
        const sigs = this.pending.map((x) => x.sig);
        const r = await this.rpc.call('getSignatureStatuses', [sigs, { searchTransactionHistory: true }]);
        const keep = [];
        this.pending.forEach((x, i) => {
          const st = r.value?.[i];
          if (!st && now - x.at < 180_000) keep.push(x);
          else if (st && !st.err && (x.kind === 'sell' || x.kind === 'buy')) keep.push({ ...x, landed: true }); // matched below
        });
        this.pending = keep;
      }
      const tokens = await this.trader.walletTokens();
      const held = new Map(tokens.filter((t) => t.amount > 0n && t.mint !== pump.WSOL).map((t) => [t.mint, t]));
      for (const t of held.values()) {
        const id = 'real:' + t.mint;
        const p = this.positions.get(id);
        if (p) {
          p.missingSeen = 0;
          if (p.state !== 'selling' && BigInt(p.tokens) !== t.amount) {
            // more coins than we booked? a second buy landed after all: add its exact cost
            const extra = t.amount > BigInt(p.tokens) && this.pending.find((x) => x.kind === 'buy' && x.mint === t.mint && x.landed && x.sig !== p.buySig);
            if (extra) {
              const tx = await this.rpc.call('getTransaction', [extra.sig, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }]).catch(() => null);
              if (tx?.meta && !tx.meta.err) {
                const d = readMeta(tx, this.wallet.address, t.ata);
                const add = -d.solDelta - d.rentDeposit;
                if (add > 0n) p.costLamports = BigInt(p.costLamports || 0n) + add;
                this.pending = this.pending.filter((x) => x.sig !== extra.sig);
              }
            }
            p.tokens = t.amount;
          }
          this.pending = this.pending.filter((x) => !(x.kind === 'buy' && x.sig === p.buySig && x.landed));
          continue;
        }
        if (this._tradesBusy() || this.buying.has(t.mint)) continue;
        const meta = await this._readCoin(t.mint).catch(() => null);
        const landedBuy = this.pending.find((x) => x.kind === 'buy' && x.mint === t.mint && x.landed);
        if (landedBuy) {
          // The app closed mid-buy: adopt it as a normal bot trade with its exact cost.
          const tx = await this.rpc.call('getTransaction', [landedBuy.sig, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }]).catch(() => null);
          if (tx?.meta) {
            const d = readMeta(tx, this.wallet.address, t.ata);
            this.pending = this.pending.filter((x) => x.sig !== landedBuy.sig);
            this.bought.add(id);
            this.positions.set(id, {
              id, mode: 'real', mint: t.mint, name: meta?.meta?.name || 'Coin ' + short(t.mint), symbol: meta?.meta?.symbol || short(t.mint),
              curveAddr: await pump.bondingCurveAddress(t.mint), tokenProgram: t.tokenProgram, tokens: t.amount,
              costLamports: -d.solDelta - d.rentDeposit, rentDeposit: d.rentDeposit, buySig: landedBuy.sig, via: 'pump.fun',
              managed: true, source: 'auto', openedAt: landedBuy.at, peakValueLamports: 0n, state: 'open', sellAttempts: 0, nextSellAt: 0,
            });
            this.log('info', `Recovered the ${meta?.meta?.symbol || short(t.mint)} buy that finished while the app was closed. The bot is managing it.`, { mint: t.mint, sig: landedBuy.sig });
            continue;
          }
        }
        this.positions.set(id, {
          id, mode: 'real', mint: t.mint, name: meta?.meta?.name || 'Coin ' + short(t.mint), symbol: meta?.meta?.symbol || short(t.mint),
          curveAddr: await pump.bondingCurveAddress(t.mint), tokenProgram: t.tokenProgram, tokens: t.amount,
          costLamports: 0n, found: true, managed: false, source: 'wallet', openedAt: now, peakValueLamports: 0n, state: 'open', sellAttempts: 0, nextSellAt: 0,
        });
        this.log('info', `Found ${meta?.meta?.symbol || short(t.mint)} in the bot wallet. It's listed under Trades; the bot won't sell it unless you tap Sell.`, { mint: t.mint });
      }
      for (const p of [...this.positions.values()]) {
        if (p.mode !== 'real' || p.state === 'selling' || held.has(p.mint) || now - p.openedAt < 60_000) continue;
        if (this._tradesBusy()) continue;
        // only after two checks in a row, so a lagging node can't make us drop a coin we still hold
        p.missingSeen = (p.missingSeen || 0) + 1;
        if (p.missingSeen < 2) continue;
        const landed = await this._landedSell(p).catch(() => null);
        this._close(p, { proceeds: landed?.solDelta ?? null, reason: landed ? (p.sellReason || 'Sold') : 'Sold outside the bot', sig: landed?.sig || null, via: 'unknown' });
      }
      this._save();
      this._ensureLoop();
    } finally {
      this.reconciling = false;
      this._emit();
    }
  }

  // ---------- wallet tracker & copy trading ----------

  walletLabel(address) {
    const w = this.wallets.find((x) => x.address === address);
    return w?.username ? '@' + w.username : w?.label || short(address);
  }

  /** Start tracking a wallet (an address, a pump.fun profile link or an @username). */
  async trackWallet(text) {
    const { address, username } = await resolveWallet(text, this.fetchImpl);
    if (this.wallet && address === this.wallet.address) throw new Error("That's the bot's own wallet.");
    if (this.wallets.some((w) => w.address === address)) throw new Error('You already track this wallet.');
    if (this.wallets.length >= MAX_WALLETS) throw new Error(`You can track up to ${MAX_WALLETS} wallets. Remove one first.`);
    const w = normalizeWallet({ address, username, addedAt: this.now() });
    this.wallets.unshift(w);
    this._saveWallets();
    this._syncWatches();
    this._emit();
    this.refreshWallet(address, { initial: true }).catch(() => {});
    return w;
  }

  untrackWallet(address) {
    this.wallets = this.wallets.filter((w) => w.address !== address);
    this._saveWallets();
    this._syncWatches();
    this._emit();
  }

  updateWallet(address, patch) {
    const w = this.wallets.find((x) => x.address === address);
    if (!w) return;
    if (patch.copy !== undefined) w.copy = !!patch.copy;
    if (patch.copySol !== undefined) {
      const v = Number(patch.copySol);
      if (!(v > 0)) throw new Error('Enter how much SOL to spend on each copied trade.');
      w.copySol = Math.min(100, Math.max(0.001, v));
    }
    if (patch.label !== undefined) w.label = String(patch.label || '').slice(0, 24) || null;
    this._saveWallets();
    this._emit();
  }

  /** Balance and recent trades (also catches up on anything missed while the app was closed). */
  async refreshWallet(address, { initial = false } = {}) {
    const w = this.wallets.find((x) => x.address === address);
    if (!w || !this.rpc || w.loading) return;
    w.loading = true;
    this._emit();
    try {
      const bal = await this.rpc.call('getBalance', [address, { commitment: 'confirmed' }]).catch(() => null);
      if (bal) w.balance = BigInt(bal.value);
      const sigs = await this.rpc.call('getSignaturesForAddress', [address, { limit: 20, commitment: 'confirmed' }]);
      const fresh = (sigs || []).filter((x) => !x.err && !w.seen.has(x.signature)).slice(0, 15).reverse();
      for (const x of fresh) {
        if (!this.wallets.includes(w)) return;
        const tx = await this.rpc.call('getTransaction', [x.signature, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }]).catch(() => null);
        w.seen.add(x.signature);
        if (!tx?.meta || tx.meta.err) continue;
        const act = walletActivityFromLogs(tx.meta.logMessages, address);
        if (!act.trades.length && !act.amm.length) continue;
        const at = x.blockTime ? x.blockTime * 1000 : this.now();
        // copy buys only if they're fresh; copy sells always (so you're never left holding)
        this._walletTrades(w, x.signature, act, at, { copyBuys: !initial && this.now() - at < 30_000, copySells: !initial });
      }
      w.lastCheckedAt = this.now();
    } finally {
      w.loading = false;
      this._saveWallets();
      this._emit();
    }
  }

  _onWalletLogs(address, sig, logs) {
    const w = this.wallets.find((x) => x.address === address);
    if (!w || w.seen.has(sig)) return;
    const act = walletActivityFromLogs(logs, address);
    w.seen.add(sig);
    if (!act.trades.length && !act.amm.length) return;
    this._walletTrades(w, sig, act, this.now(), { copyBuys: true, copySells: true });
    this._saveWallets();
    this._emit();
  }

  _walletTrades(w, sig, { trades = [], amm = [] }, at, { copyBuys, copySells }) {
    for (const ev of amm) this._walletAmmTrade(w, sig, ev, at, { copyBuys, copySells });
    for (const ev of trades) {
      const before = BigInt(w.holdings[ev.mint] || 0n);
      w.holdings[ev.mint] = ev.isBuy ? before + ev.tokenAmount : before > ev.tokenAmount ? before - ev.tokenAmount : 0n;
      if (!ev.isBuy && w.holdings[ev.mint] === 0n) delete w.holdings[ev.mint];
      const meta = this._meta(ev.mint);
      const entry = { sig, mint: ev.mint, buy: ev.isBuy, sol: Number(ev.solAmount) / 1e9, t: at, symbol: meta?.symbol || null, name: meta?.name || null, note: null };
      w.trades.unshift(entry);
      if (w.trades.length > 40) w.trades.length = 40;
      w.lastTradeAt = Math.max(w.lastTradeAt || 0, at);
      if (ev.isBuy && copyBuys && w.copy) this._copyBuy(w, ev, entry).catch(() => {});
      if (!ev.isBuy && copySells) this._copySell(w, ev, before, entry);
    }
  }

  /** A tracked wallet traded a graduated coin on PumpSwap. */
  _walletAmmTrade(w, sig, ev, at, { copyBuys, copySells }) {
    const entry = { sig, mint: null, pool: ev.pool, buy: ev.isBuy, sol: Number(ev.solAmount) / 1e9, t: at, symbol: null, name: null, note: null };
    w.trades.unshift(entry);
    if (w.trades.length > 40) w.trades.length = 40;
    w.lastTradeAt = Math.max(w.lastTradeAt || 0, at);
    const work = this._poolMint(ev.pool).then((mint) => {
      if (!mint) {
        if (ev.isBuy && copyBuys && w.copy) entry.note = "Not copied: this pool isn't a SOL pool";
        this._emit();
        return;
      }
      entry.mint = mint;
      const meta = this._meta(mint);
      if (meta) { entry.symbol = meta.symbol; entry.name = meta.name; }
      const before = BigInt(w.holdings[mint] || 0n);
      w.holdings[mint] = ev.isBuy ? before + ev.baseAmount : before > ev.baseAmount ? before - ev.baseAmount : 0n;
      if (!ev.isBuy && w.holdings[mint] === 0n) delete w.holdings[mint];
      if (ev.isBuy && copyBuys && w.copy && ev.baseAmount > 0n) {
        // their average price (fees included) is the reference for "don't chase"
        const price = Number(ev.solAmount) / Number(ev.baseAmount);
        return this._copyBuy(w, { mint, solAmount: ev.solAmount, solPaired: true, price, pool: ev.pool }, entry);
      }
      if (!ev.isBuy && copySells) {
        const theirBefore = ev.userBaseBefore > 0n ? ev.userBaseBefore : before;
        const fraction = theirBefore > 0n ? Number(ev.baseAmount) / Number(theirBefore) : 1;
        if (this._followSell(w, mint, fraction)) entry.note = 'Copied the sell';
      }
      this._emit();
    }).catch(() => {});
    (this.pendingCopies ||= new Set()).add(work);
    work.finally(() => this.pendingCopies.delete(work));
  }

  /** Which coin a SOL PumpSwap pool trades (cached). null for pools not paired with SOL. */
  async _poolMint(pool) {
    this.poolMints ||= new Map();
    if (this.poolMints.has(pool)) return this.poolMints.get(pool);
    for (const p of this.positions.values()) {
      if (p.pool === pool || await pump.canonicalPoolAddress(p.mint) === pool) { this.poolMints.set(pool, p.mint); return p.mint; }
    }
    if (!this.rpc) return null;
    const r = await this.rpc.call('getMultipleAccounts', [[pool], { encoding: 'base64', commitment: 'confirmed' }]);
    const a = r?.value?.[0];
    const ps = a && a.owner === pump.PUMP_AMM ? pump.decodePool(fromBase64(a.data[0])) : null;
    if (!ps) return null;
    const mint = ps.quoteMint === pump.WSOL && ps.baseMint !== pump.WSOL ? ps.baseMint : null;
    this.poolMints.set(pool, mint);
    return mint;
  }

  /** Name and symbol of a coin for the tracker (looked up once, in the background). */
  _meta(mint) {
    const c = this.coins.get(mint);
    if (c) return { name: c.name, symbol: c.symbol };
    const hit = this.metaCache.get(mint);
    if (hit !== undefined) return hit;
    this.metaCache.set(mint, null);
    if (this.metaCache.size > 500) this.metaCache.delete(this.metaCache.keys().next().value);
    if (this.rpc) {
      this._readCoin(mint).then((st) => {
        const m = st.meta ? { name: st.meta.name, symbol: st.meta.symbol } : null;
        this.metaCache.set(mint, m);
        if (m) for (const w of this.wallets) for (const t of w.trades) if (t.mint === mint && !t.symbol) { t.symbol = m.symbol; t.name = m.name; }
        this._emit();
      }).catch(() => {});
    }
    return null;
  }

  async _copyBuy(w, ev, entry) {
    const mode = this.settings.mode;
    const id = mode + ':' + ev.mint;
    const who = this.walletLabel(w.address);
    const skip = (why) => { entry.note = 'Not copied: ' + why; this.log('skip', `Didn't copy ${who}'s buy of ${entry.symbol || short(ev.mint)}: ${why}.`, { mint: ev.mint }); this._emit(); };
    if (!this.wallet || !this.rpc) return skip('finish setup first');
    if (this.positions.has(id) || this.buying.has(ev.mint)) { entry.note = 'Already copied this coin'; this._emit(); return; }
    if (ev.solPaired === false) return skip("it isn't a SOL coin");
    if (Number(ev.solAmount) / 1e9 < w.minLeaderSol) return skip('their buy was tiny');
    if (ev.realTokenReserves === 0n) return skip('it just graduated');
    const rules = this.rules();
    // every coin they buy gets copied: no cap on how many are open. If the full amount
    // isn't there, copy with what's left (keeping the reserve and other copies in flight)
    const reserve = pump.solToLamports(mode === 'real' ? rules.keepSolReserve + FEE_BUFFER_SOL : 0.001);
    this.copyCommitted ||= { practice: 0n, real: 0n };
    const free = this.availableLamports(mode) - reserve - this.copyCommitted[mode];
    const want = pump.solToLamports(w.copySol);
    const lamports = free < want ? free : want;
    if (lamports < pump.solToLamports(MIN_COPY_SOL)) return skip(`not enough SOL left (${pump.lamportsToSol(free > 0n ? free : 0n).toFixed(3)} SOL free)`);
    const sol = Number(lamports) / 1e9;
    const smaller = lamports < want;
    // don't chase: skip if the price ran more than 25% past what they paid (checked inside the buy, no extra wait)
    const theirs = ev.price ?? Number(ev.virtualSolReserves) / Number(ev.virtualTokenReserves);
    entry.note = 'Copying…';
    this._emit();
    this.copyCommitted[mode] += lamports;
    let held = true;
    const release = () => { if (held) { held = false; this.copyCommitted[mode] -= lamports; } };
    try {
      const p = await this._buy(ev.mint, sol, 'copy', { copiedFrom: w.address, ...(ev.creator ? { creator: ev.creator } : {}) }, { maxPrice: theirs > 0 ? theirs * 1.25 : null, refPrice: theirs > 0 ? theirs : null, pool: ev.pool || null, onSpent: release });
      entry.note = smaller ? `Copied with ${+sol.toFixed(3)} SOL (all that was left)` : 'Copied';
      // they already sold everything while our buy was landing: don't get left holding it
      if (p && !(BigInt(w.holdings[ev.mint] || 0n) > 0n) && this.positions.get(p.id) === p) {
        p.sellRequested = `${who} already sold`;
        p.nextSellAt = 0;
        this._sell(p, p.sellRequested);
      }
    } catch (e) {
      if (e?.kind === 'skipped') skip(e.message);
      else entry.note = 'Copy failed: ' + (e.message || 'error');
    } finally {
      release();
      this._saveWallets();
      this._emit();
    }
  }

  _copySell(w, ev, theirBefore, entry) {
    const fraction = theirBefore > 0n ? Number(ev.tokenAmount) / Number(theirBefore) : 1;
    if (this._followSell(w, ev.mint, fraction)) entry.note = 'Copied the sell';
  }

  /** Sell the same share of our copied position as they just sold. Returns true if there was one. */
  _followSell(w, mint, fraction) {
    let hit = false;
    for (const p of this.positions.values()) {
      if (p.mint !== mint || p.copiedFrom !== w.address) continue;
      hit = true;
      const who = this.walletLabel(w.address);
      if (fraction >= 0.9) {
        p.sellRequested = `${who} sold`;
        p.nextSellAt = 0;
        if (p.state !== 'selling') this._sell(p, p.sellRequested);
      } else if (p.state !== 'selling') {
        this._sellPart(p, fraction, `${who} sold ${Math.round(fraction * 100)}%`);
      }
      this._ensureLoop();
    }
    return hit;
  }

  // ---------- numbers for the screen ----------

  stats(mode = this.settings.mode) {
    const all = this.history.filter((h) => h.mode === mode && h.pnlLamports !== null && !h.found);
    const list = all.filter((h) => !h.partial);
    const wins = list.filter((h) => h.pnlLamports > 0n).length;
    const total = all.reduce((s, h) => s + BigInt(h.pnlLamports), 0n);
    this._rollDay();
    return { trades: list.length, wins, losses: list.length - wins, totalLamports: total, todayLamports: this.daily[mode] || 0n };
  }

  /** What the bot is thinking, for the screen. */
  brain() {
    const coins = [...this.coins.values()];
    const studying = coins.filter((c) => c.stage === 'study').sort((a, b) => (b.verdict?.score || 0) - (a.verdict?.score || 0));
    const passed = coins.filter((c) => c.stage === 'passed');
    return { studying, passed, pipeline: this.pipeline, pickiness: this.pickiness(), lossStreak: this.lossStreak?.[this.settings.mode] || 0 };
  }

  openValue(mode = this.settings.mode) {
    return this._openPositions(mode).reduce((s, p) => s + BigInt(p.lastValueLamports ?? p.costLamports ?? 0n), 0n);
  }
}
