// The bot's wallet keypair: create, import, export and sign.
// Signing uses the browser's built-in Ed25519 when it produces exactly the
// same signature as our own implementation (checked once per key), otherwise
// our own implementation. Either way the result is a standard signature.

import { b58decode, b58encode } from './b58.js';
import { concat, equalBytes } from './bytes.js';
import * as ed from './ed25519.js';

const PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);
const SELF_TEST_MESSAGE = new TextEncoder().encode('win-bot signing self-test');

export class Keypair {
  constructor(seed, publicKey) {
    this.seed = seed;
    this.publicKey = publicKey;
    this.address = b58encode(publicKey);
    this._native = undefined; // undefined = not tested yet, null = unavailable
  }

  static async generate() {
    const s = new Uint8Array(32);
    crypto.getRandomValues(s);
    return Keypair.fromSeed(s);
  }

  static async fromSeed(s) {
    if (!(s instanceof Uint8Array) || s.length !== 32) throw new Error('Secret must be 32 bytes');
    const pub = await ed.getPublicKey(s);
    return new Keypair(s.slice(), pub);
  }

  /**
   * Accepts the formats wallets export:
   * - base58 of 64 bytes (Phantom / Solflare "private key")
   * - JSON array of 64 numbers (Solana CLI id.json)
   * - base58 of a 32-byte seed
   */
  static async fromSecretText(text) {
    const t = String(text || '').trim();
    if (!t) throw new Error('Paste a private key first.');
    let bytes;
    if (t.startsWith('[')) {
      let arr;
      try { arr = JSON.parse(t); } catch { throw new Error("That key isn't valid. Check you copied all of it."); }
      if (!Array.isArray(arr) || !arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
        throw new Error("That key isn't valid. Check you copied all of it.");
      }
      bytes = Uint8Array.from(arr);
    } else {
      try { bytes = b58decode(t.replace(/\s+/g, '')); } catch { throw new Error("That key isn't valid. Check you copied all of it."); }
    }
    if (bytes.length === 64) {
      const kp = await Keypair.fromSeed(bytes.slice(0, 32));
      if (!equalBytes(kp.publicKey, bytes.slice(32))) {
        throw new Error("That key doesn't check out (its two halves don't match). Copy it again.");
      }
      return kp;
    }
    if (bytes.length === 32) return Keypair.fromSeed(bytes);
    throw new Error("That doesn't look like a Solana private key. It should be about 88 characters long.");
  }

  /** base58 of seed + public key: the format Phantom's "Import Private Key" accepts. */
  exportSecret() {
    return b58encode(concat(this.seed, this.publicKey));
  }

  async _nativeKey() {
    if (this._native !== undefined) return this._native;
    this._native = null;
    try {
      if (!globalThis.crypto?.subtle) return null;
      const key = await crypto.subtle.importKey('pkcs8', concat(PKCS8_PREFIX, this.seed), { name: 'Ed25519' }, false, ['sign']);
      const nativeSig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, SELF_TEST_MESSAGE));
      const ourSig = await ed.sign(SELF_TEST_MESSAGE, this.seed);
      if (equalBytes(nativeSig, ourSig)) this._native = key;
    } catch {
      this._native = null;
    }
    return this._native;
  }

  async sign(message) {
    const key = await this._nativeKey();
    if (key) return new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, message));
    return ed.sign(message, this.seed);
  }
}
