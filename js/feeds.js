// Live feed of newly launched pump.fun coins, from two independent sources:
//  1. your Solana connection: transactions that touch pump.fun's mint
//     authority (only coin launches do), decoded from the program's own logs;
//  2. PumpPortal's free "new token" stream.
// Either one alone is enough. Coins are de-duplicated by mint address.

import { isAddress } from './b58.js?v=2.3.0';
import { pumpEventsFromLogs, mintAuthorityAddress } from './pump.js?v=2.3.0';
import { ChainStream } from './rpc.js?v=2.3.0';

const PUMPPORTAL_WS = 'wss://pumpportal.fun/api/data';

function cleanText(s, max) {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').trim().slice(0, max);
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** Normalise a PumpPortal "create" message. Returns null if it isn't one. */
export function coinFromPumpPortal(m, now = Date.now()) {
  if (!m || m.txType !== 'create' || !isAddress(m.mint)) return null;
  if (m.pool && m.pool !== 'pump') return null;
  const devSol = num(m.solAmount);
  return {
    mint: m.mint,
    name: cleanText(m.name, 40) || 'Unnamed',
    symbol: cleanText(m.symbol, 16) || '???',
    creator: isAddress(m.traderPublicKey) ? m.traderPublicKey : null,
    tokenProgram: null,
    isMayhemMode: typeof m.is_mayhem_mode === 'boolean' ? m.is_mayhem_mode : typeof m.isMayhemMode === 'boolean' ? m.isMayhemMode : null,
    devBuySol: devSol !== null && devSol < 1000 ? devSol : null,
    devBuyTokens: num(m.initialBuy) !== null ? BigInt(Math.round(m.initialBuy * 1e6)) : null,
    createdAt: now,
    source: 'pumpportal',
  };
}

/** A new coin from a creation transaction's logs, with the creator's first buy. */
export function coinsFromCreateLogs(signature, logs, now = Date.now()) {
  const { creates, trades } = pumpEventsFromLogs(logs);
  return creates.map((ev) => {
    const devBuys = trades.filter((t) => t.mint === ev.mint && t.isBuy && (t.user === ev.creator || t.user === ev.user));
    const coin = {
      mint: ev.mint,
      name: ev.name || 'Unnamed',
      symbol: ev.symbol || '???',
      creator: ev.creator,
      tokenProgram: ev.tokenProgram || null,
      isMayhemMode: ev.isMayhemMode ?? null,
      createdAt: now,
      createSig: signature,
      source: 'chain',
    };
    if (devBuys.length) {
      coin.devBuySol = devBuys.reduce((a, t) => a + Number(t.solAmount), 0) / 1e9;
      coin.devBuyTokens = devBuys.reduce((a, t) => a + t.tokenAmount, 0n);
    } else coin.devBuySol = 0;
    return coin;
  });
}

export class PumpPortalFeed {
  constructor({ onCoin, onStatus, WebSocketImpl, url = PUMPPORTAL_WS } = {}) {
    this.onCoin = onCoin;
    this.onStatus = onStatus || (() => {});
    this.WS = WebSocketImpl || globalThis.WebSocket;
    this.url = url;
    this.stopped = true;
    this.backoff = 5000;
    this.status = 'off';
    this.lastMessageAt = 0;
  }

  _setStatus(s) { if (this.status !== s) { this.status = s; this.onStatus(s); } }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this._connect();
    this.watchdog = setInterval(() => {
      // PumpPortal sends launches constantly; silence means a dead socket.
      if (!this.stopped && this.status === 'live' && Date.now() - this.lastMessageAt > 90000) { try { this.ws?.close(); } catch {} }
    }, 15000);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.watchdog);
    clearTimeout(this.retryTimer);
    try { this.ws?.close(); } catch {}
    this.ws = null;
    this._setStatus('off');
  }

  _connect() {
    if (this.stopped) return;
    // PumpPortal asks for a single connection at a time.
    if (this.ws) return;
    this._setStatus('connecting');
    let ws;
    try { ws = new this.WS(this.url); } catch { this._retry(); return; }
    this.ws = ws;
    ws.onopen = () => {
      this.lastMessageAt = Date.now();
      ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
    };
    ws.onmessage = (ev) => {
      this.lastMessageAt = Date.now();
      let m;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch { return; }
      if (m && typeof m.message === 'string' && /subscrib/i.test(m.message)) { this.backoff = 5000; this._setStatus('live'); return; }
      const coin = coinFromPumpPortal(m);
      if (coin) {
        this.backoff = 5000;
        this._setStatus('live');
        this.onCoin(coin);
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      if (this.stopped) return;
      this._setStatus('connecting');
      this._retry();
    };
  }

  _retry() {
    clearTimeout(this.retryTimer);
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 60000);
    this.retryTimer = setTimeout(() => this._connect(), wait);
  }
}

export class CoinFeed {
  /**
   * stream: a shared ChainStream (the bot's). Without one, wsUrl makes a
   * private stream. onCoin(coin) gets each new coin once; a second report of
   * the same coin from the other source arrives with coin.update = true.
   */
  constructor({ wsUrl, stream, onCoin, onStatus, WebSocketImpl } = {}) {
    this.onCoin = onCoin;
    this.onStatus = onStatus || (() => {});
    this.WS = WebSocketImpl;
    this.wsUrl = wsUrl;
    this.stream = stream || null;
    this.seen = new Set();
    this.seenOrder = [];
    this.status = { chain: 'off', pumpportal: 'off' };
    this.count = 0;
    this.lastCoinAt = 0;
  }

  _emit(coin) {
    if (this.seen.has(coin.mint)) { this.onCoin({ ...coin, update: true }); return; }
    this.seen.add(coin.mint);
    this.seenOrder.push(coin.mint);
    if (this.seenOrder.length > 5000) this.seen.delete(this.seenOrder.shift());
    this.count++;
    this.lastCoinAt = Date.now();
    this.onCoin(coin);
  }

  async start() {
    if (this.running) return;
    this.running = true;
    if (!this.stream && this.wsUrl) {
      this.ownStream = new ChainStream(this.wsUrl, { WebSocketImpl: this.WS });
      this.stream = this.ownStream;
    }
    if (this.stream) {
      const setChain = (st) => { this.status.chain = st; this.onStatus(this.status); };
      this.offStatus = this.stream.onStatus(setChain);
      const mention = await mintAuthorityAddress();
      if (!this.running) return;
      this.unsub = this.stream.subscribe(mention, (signature, logs) => {
        for (const c of coinsFromCreateLogs(signature, logs)) this._emit(c);
      }, { busy: true });
      if (this.ownStream) this.ownStream.start();
      setChain(this.stream.status);
    }
    this.portal = new PumpPortalFeed({
      WebSocketImpl: this.WS,
      onCoin: (c) => this._emit(c),
      onStatus: (s) => { this.status.pumpportal = s; this.onStatus(this.status); },
    });
    this.portal.start();
  }

  stop() {
    this.running = false;
    this.unsub?.();
    this.unsub = null;
    this.offStatus?.();
    this.offStatus = null;
    if (this.ownStream) { this.ownStream.stop(); this.stream = null; this.ownStream = null; } // a shared stream stays up for the bot
    this.portal?.stop();
    this.portal = null;
    this.status = { chain: 'off', pumpportal: 'off' };
    this.onStatus(this.status);
  }

  isLive() {
    return this.status.chain === 'live' || this.status.pumpportal === 'live';
  }
}
