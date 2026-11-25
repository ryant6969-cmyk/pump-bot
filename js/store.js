// Saving the app's data on this phone (localStorage). BigInts are stored as
// {"$big": "123"} so amounts in lamports / raw tokens survive exactly.

const PREFIX = 'winbot.v1.';

function replacer(_k, v) { return typeof v === 'bigint' ? { $big: v.toString() } : v; }
function reviver(_k, v) { return v && typeof v === 'object' && typeof v.$big === 'string' && Object.keys(v).length === 1 ? BigInt(v.$big) : v; }

export class Store {
  constructor(storage) {
    try { this.s = storage || globalThis.localStorage || null; } catch { this.s = null; }
    this.memory = new Map();
    this.ok = this._probe();
  }

  _probe() {
    if (!this.s) return false;
    try {
      this.s.setItem(PREFIX + 'probe', '1');
      this.s.removeItem(PREFIX + 'probe');
      return true;
    } catch { return false; }
  }

  load(name, fallback) {
    try {
      const raw = this.s ? this.s.getItem(PREFIX + name) : this.memory.get(name);
      if (raw === null || raw === undefined) return fallback;
      return JSON.parse(raw, reviver);
    } catch { return fallback; }
  }

  save(name, value) {
    const raw = JSON.stringify(value, replacer);
    this.memory.set(name, raw);
    if (!this.s) return false;
    try { this.s.setItem(PREFIX + name, raw); return true; } catch { return false; }
  }

  remove(name) {
    this.memory.delete(name);
    try { this.s?.removeItem(PREFIX + name); } catch {}
  }

  clearAll() {
    this.memory.clear();
    if (!this.s) return;
    try {
      const keys = [];
      for (let i = 0; i < this.s.length; i++) { const k = this.s.key(i); if (k && k.startsWith(PREFIX)) keys.push(k); }
      for (const k of keys) this.s.removeItem(k);
    } catch {}
  }
}

/** Ask the browser not to clear our data when space runs low (Safari 17+). */
export async function requestPersistentStorage() {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch {}
  return false;
}
