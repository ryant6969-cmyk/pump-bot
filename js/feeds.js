// Live feed of newly launched pump.fun coins, from two independent sources:
//  1. your Solana connection: transactions that touch pump.fun's mint
//     authority (only coin launches do), decoded from the program's own logs;
//  2. PumpPortal's free "new token" stream.
// Either one alone is enough. Coins are de-duplicated by mint address.

import { isAddress } from './b58.js';
import { createEventsFromLogs, mintAuthorityAddress } from './pump.js';
import { LogsSubscription } from './rpc.js';

const PUMPPORTAL_WS = 'wss://pumpportal.fun/api/data';

function cleanText(s, max) {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').trim().slice(0, max);
}

/** Normalise a PumpPortal "create" message. Returns null if it isn't one. */
export function coinFromPumpPortal(m, now = Date.now()) {
  if (!m || m.txType !== 'create' || !isAddress(m.mint)) return null;
  if (m.pool && m.pool !== 'pump') return null;
  return {
    mint: m.mint,
    name: cleanText(m.name, 40) || 'Unnamed',
    symbol: cleanText(m.symbol, 16) || '???',
    creator: isAddress(m.traderPublicKey) ? m.traderPublicKey : null,
    tokenProgram: null,
    isMayhemMode: null,
    createdAt: now,
    source: 'pumpportal',
  };
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
  constructor({ wsUrl, onCoin, onStatus, WebSocketImpl } = {}) {
    this.onCoin = onCoin;
    this.onStatus = onStatus || (() => {});
    this.WS = WebSocketImpl;
    this.wsUrl = wsUrl;
    this.seen = new Set();
    this.seenOrder = [];
    this.status = { chain: 'off', pumpportal: 'off' };
    this.count = 0;
    this.lastCoinAt = 0;
  }

  _emit(coin) {
    if (this.seen.has(coin.mint)) return;
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
    if (this.wsUrl) {
      const mention = await mintAuthorityAddress();
      this.chain = new LogsSubscription(this.wsUrl, mention, {
        WebSocketImpl: this.WS,
        onStatus: (s) => { this.status.chain = s; this.onStatus(this.status); },
        onLogs: (signature, logs) => {
          for (const ev of createEventsFromLogs(logs)) {
            this._emit({
              mint: ev.mint,
              name: ev.name || 'Unnamed',
              symbol: ev.symbol || '???',
              creator: ev.creator,
              tokenProgram: ev.tokenProgram || null,
              isMayhemMode: ev.isMayhemMode ?? null,
              createdAt: Date.now(),
              source: 'chain',
            });
          }
        },
      });
      this.chain.start();
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
    this.chain?.stop();
    this.portal?.stop();
    this.chain = null;
    this.portal = null;
  }

  isLive() {
    return this.status.chain === 'live' || this.status.pumpportal === 'live';
  }
}
