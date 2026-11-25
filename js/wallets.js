// Wallet tracker and copy trading helpers: turning what the user typed
// (an address, a pump.fun profile link, or an @username) into a wallet
// address, and reading a wallet's pump.fun trades out of a transaction.

import { isAddress } from './b58.js';
import { pumpEventsFromLogs } from './pump.js';

const USER_API = 'https://frontend-api-v3.pump.fun/users/';

/** What kind of thing the user typed: { address } or { username } or null. */
export function parseWalletInput(text) {
  let s = String(text || '').trim();
  if (!s) return null;
  const link = s.match(/pump\.fun\/(?:profile|user)\/([^/?#\s]+)/i);
  if (link) s = decodeURIComponent(link[1]);
  const solscan = s.match(/(?:solscan\.io|solana\.fm|explorer\.solana\.com)\/(?:account|address)\/([1-9A-HJ-NP-Za-km-z]{32,44})/i);
  if (solscan) s = solscan[1];
  s = s.replace(/^@+/, '').trim();
  if (isAddress(s)) return { address: s };
  if (/^[A-Za-z0-9_.-]{2,32}$/.test(s)) return { username: s };
  return null;
}

function findAddress(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 3) return null;
  for (const k of ['address', 'wallet', 'walletAddress', 'publicKey', 'user']) {
    if (typeof obj[k] === 'string' && isAddress(obj[k])) return obj[k];
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') { const a = findAddress(v, depth + 1); if (a) return a; }
  }
  return null;
}

/**
 * Resolve the user's input to { address, username }. Usernames are looked up
 * on pump.fun; if that lookup is blocked on this phone, the error says how to
 * paste the address instead.
 */
export async function resolveWallet(text, fetchImpl) {
  const p = parseWalletInput(text);
  if (!p) throw new Error('Paste a wallet address, a pump.fun profile link, or an @username.');
  if (p.address) return { address: p.address, username: null };
  const f = fetchImpl || ((...a) => globalThis.fetch(...a));
  let j = null;
  try {
    const r = await f(USER_API + encodeURIComponent(p.username), { headers: { Accept: 'application/json' } });
    if (r.status === 404) throw Object.assign(new Error('notfound'), { notFound: true });
    if (!r.ok) throw new Error('http ' + r.status);
    j = await r.json();
  } catch (e) {
    if (e.notFound) throw new Error(`pump.fun has no user called @${p.username}.`);
    throw new Error(`Couldn't look up @${p.username} from this phone. Open their pump.fun profile, copy their wallet address (under their name), and paste that instead.`);
  }
  const address = findAddress(j);
  if (!address) throw new Error(`pump.fun has no wallet for @${p.username}. Paste their wallet address instead.`);
  return { address, username: typeof j?.username === 'string' ? j.username.slice(0, 32) : p.username };
}

/** The pump.fun curve trades made by `wallet` in a transaction's logs. */
export function walletTradesFromLogs(logs, wallet) {
  return pumpEventsFromLogs(logs).trades.filter((t) => t.user === wallet);
}
