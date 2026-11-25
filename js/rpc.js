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
 * logsSubscribe for transactions mentioning one address, with automatic
 * reconnects. onLogs(signature, logs) is called for successful transactions.
 */
export class LogsSubscription {
  constructor(wsUrl, mention, { onLogs, onStatus, WebSocketImpl } = {}) {
    this.wsUrl = wsUrl;
    this.mention = mention;
    this.onLogs = onLogs || (() => {});
    this.onStatus = onStatus || (() => {});
    this.WS = WebSocketImpl || globalThis.WebSocket;
    this.ws = null;
    this.stopped = true;
    this.backoff = 1000;
    this.lastMessageAt = 0;
    this.status = 'off';
  }

  _setStatus(s) { if (this.status !== s) { this.status = s; this.onStatus(s); } }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this._connect();
    this.watchdog = setInterval(() => {
      if (this.stopped) return;
      if (this.status === 'live' && Date.now() - this.lastMessageAt > 120000) this._reconnect();
    }, 10000);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.watchdog);
    clearTimeout(this.retryTimer);
    try { this.ws?.close(); } catch {}
    this.ws = null;
    this._setStatus('off');
  }

  _reconnect() {
    try { this.ws?.close(); } catch {}
  }

  _connect() {
    if (this.stopped) return;
    this._setStatus('connecting');
    let ws;
    try { ws = new this.WS(this.wsUrl); } catch { this._scheduleRetry(); return; }
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [this.mention] }, { commitment: 'confirmed' }] }));
    };
    ws.onmessage = (ev) => {
      this.lastMessageAt = Date.now();
      let m;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch { return; }
      if (m.id === 1) {
        if (m.error) { this._setStatus('down'); try { ws.close(); } catch {} return; }
        this.backoff = 1000;
        this._setStatus('live');
        return;
      }
      if (m.method === 'logsNotification') {
        const v = m.params?.result?.value;
        if (v && !v.err && Array.isArray(v.logs) && typeof v.signature === 'string') {
          try { this.onLogs(v.signature, v.logs); } catch (e) { console.warn('log handler', e); }
        }
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
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
