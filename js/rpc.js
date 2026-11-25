// Talking to Solana: JSON-RPC over HTTPS (with rate limiting and retries)
// and a WebSocket log subscription that reconnects by itself.

export class RpcError extends Error {
  constructor(message, { code = null, data = null, retryable = false, status = null } = {}) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
    this.retryable = retryable;
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Turn what the user pasted (a Helius API key, a Helius URL, or any Solana
 * RPC URL) into HTTPS and WebSocket URLs. Returns null if it can't be used.
 */
export function normalizeRpcInput(input) {
  let s = String(input || '').trim().replace(/\s+/g, '');
  if (!s) return null;
  // Bare Helius key (UUID) or "api-key=..." fragment
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuid.test(s)) {
    return {
      http: `https://mainnet.helius-rpc.com/?api-key=${s}`,
      ws: `wss://mainnet.helius-rpc.com/?api-key=${s}`,
      label: 'Helius',
    };
  }
  if (/^api-key=/i.test(s)) s = 'https://mainnet.helius-rpc.com/?' + s;
  if (/^mainnet\.helius-rpc\.com/i.test(s)) s = 'https://' + s;
  if (/^http:\/\//i.test(s)) return null; // never send keys over plain http
  if (!/^https:\/\//i.test(s)) return null;
  let url;
  try { url = new URL(s); } catch { return null; }
  if (/devnet|testnet/i.test(url.hostname)) return null;
  const ws = 'wss://' + url.host + url.pathname + url.search;
  return { http: url.toString(), ws, label: /helius/i.test(url.hostname) ? 'Helius' : url.hostname };
}

export class Rpc {
  constructor(url, { maxPerSecond = 8, fetchImpl } = {}) {
    this.url = url;
    this.maxPerSecond = maxPerSecond;
    this.fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    this.recent = [];
    this.gate = Promise.resolve();
    this.id = 0;
    this.lastOkAt = 0;
    this.lastError = null;
    this.failStreak = 0;
  }

  async _slot() {
    // Simple sliding-window limiter shared by all calls.
    const prev = this.gate;
    let release;
    this.gate = new Promise((r) => (release = r));
    await prev;
    try {
      for (;;) {
        const now = Date.now();
        this.recent = this.recent.filter((t) => now - t < 1000);
        if (this.recent.length < this.maxPerSecond) { this.recent.push(now); return; }
        await sleep(1000 - (now - this.recent[0]) + 5);
      }
    } finally {
      release();
    }
  }

  async call(method, params = [], { timeoutMs = 15000, retries = 2 } = {}) {
    let attempt = 0;
    for (;;) {
      await this._slot();
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = setTimeout(() => ctrl?.abort(), timeoutMs);
      try {
        let res;
        try {
          res = await this.fetch(this.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
            signal: ctrl?.signal,
          });
        } catch (e) {
          throw new RpcError(e?.name === 'AbortError' ? 'The Solana connection timed out' : 'Could not reach the Solana connection', { retryable: true });
        }
        if (res.status === 429) throw new RpcError('Too many requests to the Solana connection', { retryable: true, status: 429 });
        if (res.status === 401 || res.status === 403) throw new RpcError('Your data key was refused. Check it in Settings.', { status: res.status });
        if (res.status >= 500) throw new RpcError('The Solana connection had a server error', { retryable: true, status: res.status });
        if (!res.ok) throw new RpcError(`The Solana connection said ${res.status}`, { status: res.status });
        let j;
        try { j = await res.json(); } catch { throw new RpcError('Unreadable reply from the Solana connection', { retryable: true }); }
        if (j.error) {
          const code = j.error.code;
          throw new RpcError(j.error.message || 'Solana error', { code, data: j.error.data, retryable: code === -32005 || code === -32004 || code === 429 });
        }
        this.lastOkAt = Date.now();
        this.failStreak = 0;
        this.lastError = null;
        return j.result;
      } catch (e) {
        this.failStreak++;
        this.lastError = e;
        if (!(e instanceof RpcError) || !e.retryable || attempt >= retries) throw e;
        attempt++;
        await sleep(400 * 2 ** attempt + Math.random() * 300);
      } finally {
        clearTimeout(timer);
      }
    }
  }
}

/**
 * One WebSocket to Solana carrying many logsSubscribe subscriptions (one per
 * address: new coins, coins being studied, coins held, tracked wallets).
 * Reconnects by itself and re-subscribes everything. Handlers get
 * (signature, logs) for successful transactions only.
 */
export class ChainStream {
  constructor(wsUrl, { WebSocketImpl, onStatus } = {}) {
    this.wsUrl = wsUrl;
    this.WS = WebSocketImpl || globalThis.WebSocket;
    this.listeners = new Set();
    if (onStatus) this.listeners.add(onStatus);
    this.subs = new Map(); // address -> { handlers, subId, reqId, busy }
    this.bySubId = new Map();
    this.reqs = new Map(); // request id -> address (this connection only)
    this.ws = null;
    this.stopped = true;
    this.backoff = 1000;
    this.lastMessageAt = 0;
    this.status = 'off';
    this.nextId = 1;
  }

  onStatus(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  _setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    for (const fn of this.listeners) { try { fn(s); } catch (e) { console.warn('status listener', e); } }
  }

  get size() { return this.subs.size; }
  has(address) { return this.subs.has(address); }

  /** Watch transactions that mention `address`. Returns a function that stops watching. */
  subscribe(address, handler, { busy = false, commitment = 'confirmed' } = {}) {
    let s = this.subs.get(address);
    if (!s) {
      s = { handlers: new Set(), subId: null, reqId: null, busy, commitment };
      this.subs.set(address, s);
      if (this.ws && this.wsOpen) this._sendSub(address, s);
    }
    if (busy) s.busy = true;
    s.handlers.add(handler);
    return () => this.unsubscribe(address, handler);
  }

  unsubscribe(address, handler) {
    const s = this.subs.get(address);
    if (!s) return;
    if (handler) s.handlers.delete(handler);
    if (handler && s.handlers.size) return;
    clearTimeout(s.retry);
    this.subs.delete(address);
    if (s.subId !== null) {
      this.bySubId.delete(s.subId);
      this._send('logsUnsubscribe', [s.subId]);
    }
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this._connect();
    this.watchdog = setInterval(() => {
      if (this.stopped || this.status !== 'live') return;
      // the new-coin subscription is never quiet for long; quiet ones may be
      const busy = [...this.subs.values()].some((s) => s.busy);
      if (Date.now() - this.lastMessageAt > (busy ? 120000 : 600000)) this._reconnect();
    }, 10000);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.watchdog);
    clearTimeout(this.retryTimer);
    for (const s of this.subs.values()) clearTimeout(s.retry);
    const ws = this.ws;
    this.ws = null;
    this.wsOpen = false;
    try { ws?.close(); } catch {}
    this._setStatus('off');
  }

  _reconnect() {
    const ws = this.ws;
    if (!ws) return;
    // drop it now (some sockets never fire onclose when the network is gone)
    this.ws = null;
    this.wsOpen = false;
    try { ws.close(); } catch {}
    if (!this.stopped) { this._setStatus('connecting'); this._scheduleRetry(); }
  }

  _send(method, params) {
    if (!this.ws || !this.wsOpen) return null;
    const id = this.nextId++;
    try { this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); } catch { return null; }
    return id;
  }

  _sendSub(address, s) {
    const id = this._send('logsSubscribe', [{ mentions: [address] }, { commitment: s.commitment || 'confirmed' }]);
    if (id !== null) { s.reqId = id; this.reqs.set(id, address); }
  }

  _connect() {
    if (this.stopped) return;
    this._setStatus('connecting');
    let ws;
    try { ws = new this.WS(this.wsUrl); } catch { this._scheduleRetry(); return; }
    this.ws = ws;
    this.wsOpen = false;
    this.nextId = 1;
    this.reqs = new Map();
    this.bySubId = new Map();
    for (const s of this.subs.values()) { s.subId = null; s.reqId = null; clearTimeout(s.retry); }
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.wsOpen = true;
      this.lastMessageAt = Date.now();
      if (!this.subs.size) { this.backoff = 1000; this._setStatus('live'); }
      for (const [address, s] of this.subs) this._sendSub(address, s);
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.lastMessageAt = Date.now();
      let m;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch { return; }
      if (m && m.id !== undefined && this.reqs.has(m.id)) {
        const address = this.reqs.get(m.id);
        this.reqs.delete(m.id);
        const s = this.subs.get(address);
        if (m.error) {
          // one refused subscription must not take the others down: retry just this one
          if (s && s.reqId === m.id) {
            s.reqId = null;
            s.fails = (s.fails || 0) + 1;
            clearTimeout(s.retry);
            s.retry = setTimeout(() => {
              if (this.subs.get(address) === s && s.subId === null && s.reqId === null && this.ws === ws && this.wsOpen) this._sendSub(address, s);
            }, Math.min(60000, 5000 * s.fails));
          }
          return;
        }
        if (!s || s.reqId !== m.id) { this._send('logsUnsubscribe', [m.result]); return; } // no longer wanted
        s.subId = m.result;
        this.bySubId.set(m.result, address);
        this.backoff = 1000;
        this._setStatus('live');
        return;
      }
      if (m && m.method === 'logsNotification') {
        const address = this.bySubId.get(m.params?.subscription);
        const s = address && this.subs.get(address);
        const v = m.params?.result?.value;
        if (!s || !v || v.err || !Array.isArray(v.logs) || typeof v.signature !== 'string') return;
        for (const h of [...s.handlers]) {
          try { h(v.signature, v.logs); } catch (e) { console.warn('log handler', e); }
        }
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.wsOpen = false;
      if (this.stopped) return;
      this._setStatus('connecting');
      this._scheduleRetry();
    };
  }

  _scheduleRetry() {
    clearTimeout(this.retryTimer);
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 30000);
    this.retryTimer = setTimeout(() => this._connect(), wait);
  }
}
