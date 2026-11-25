// Shared test harness: the whole bot against the fake network and a fake live socket.
import test from 'node:test';
import nodeCrypto from 'node:crypto';

import { b58encode } from '../js/b58.js';
import { Bot } from '../js/bot.js';
import { Keypair } from '../js/keys.js';
import { Store } from '../js/store.js';
import { associatedTokenAddress } from '../js/pda.js';
import * as pump from '../js/pump.js';
import { MockChain, encodeTokenAccount, pumpLogs } from './mockchain.mjs';

export const FAST = { pollMs: 10, resendMs: 40, heightCheckMs: 40, giveUpMs: 3000, detailsRetryMs: 10, botPollMs: 999999 };
// A fake Solana WebSocket: confirms every subscription, and lets a test push
// transaction logs to whoever subscribed to an address.
export class TestWS {
  static all = [];
  static nextSub = 1;
  constructor(url) { this.url = url; this.subs = new Map(); TestWS.all.push(this); queueMicrotask(() => this.onopen?.()); }
  send(d) {
    const m = JSON.parse(d);
    if (m.method === 'logsSubscribe') {
      const id = TestWS.nextSub++;
      this.subs.set(m.params[0].mentions[0], id);
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: m.id, result: id }) }));
    } else if (m.method === 'logsUnsubscribe') {
      for (const [a, id] of this.subs) if (id === m.params[0]) this.subs.delete(a);
    }
  }
  close() { if (this.closed) return; this.closed = true; this.onclose?.(); }
  static push(address, logs) {
    const signature = b58encode(nodeCrypto.randomBytes(64));
    for (const ws of TestWS.all) {
      if (ws.closed) continue;
      const id = ws.subs.get(address);
      if (id !== undefined) ws.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', method: 'logsNotification', params: { subscription: id, result: { context: { slot: 1 }, value: { signature, err: null, logs } } } }) });
    }
    return signature;
  }
  static watching(address) { return TestWS.all.some((ws) => !ws.closed && ws.subs.has(address)); }
}
export const SilentWS = TestWS;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(fn, ms = 4000) { const end = Date.now() + ms; while (!fn() && Date.now() < end) await sleep(10); return fn(); }
export const bots = [];
test.afterEach(() => { while (bots.length) bots.pop().dispose(); });

export class MemStorage {
  constructor() { this.m = new Map(); }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i] ?? null; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}

export async function setup({ mode = 'practice', sol = 1, style = 'balanced' } = {}) {
  const chain = new MockChain();
  const clock = { t: 1_800_000_000_000 };
  const storage = new MemStorage();
  const bot = new Bot({ store: new Store(storage), fetchImpl: chain.fetchImpl, WebSocketImpl: SilentWS, now: () => clock.t, timing: FAST });
  bots.push(bot);
  await bot.init();
  bot.updateSettings({ rpcInput: 'https://rpc.test/', style, mode, setupDone: true });
  await bot.createWallet();
  chain.addWallet(bot.wallet.address, sol);
  await bot.refreshBalance();
  const mint = b58encode(nodeCrypto.randomBytes(32));
  const { curveAddr, curveAta, creator } = await chain.addCoin({ mint });
  // a trade on the curve: the chain changes, and the trade shows up live on the socket
  const trade = async (opts) => { const ev = await chain.trade(mint, opts); TestWS.push(curveAddr, pumpLogs([ev])); return ev; };
  // other traders buying (each a different wallet, so holders stay spread out)
  const othersBuy = (solIn, user) => trade({ sol: solIn, user });
  const othersSell = async (fraction) => {
    const c = pump.decodeBondingCurve(chain.get(curveAddr).data);
    const q = BigInt(Math.round(Number(c.virtualQuoteReserves) * (1 - fraction)));
    const k = c.virtualQuoteReserves * c.virtualTokenReserves;
    const newT = k / q;
    await chain.setCurve(mint, { virtualQuoteReserves: q, virtualTokenReserves: newT, realTokenReserves: c.realTokenReserves + (newT - c.virtualTokenReserves) });
  };
  const step = async (ms = 2500) => { clock.t += ms; await bot._poll(); await sleep(1); };
  const settle = async () => { for (let i = 0; i < 400 && (bot.buyInFlight || bot.draining || [...bot.positions.values()].some((p) => p.state === 'selling')); i++) await sleep(5); };
  return { chain, bot, clock, mint, curveAddr, creator, trade, othersBuy, othersSell, step, settle, storage };
}

export async function launch(t, extra = {}) {
  t.bot.running = true;
  await t.bot._addCoin({ mint: t.mint, name: 'Rocket Dog', symbol: 'RDOG', creator: null, tokenProgram: pump.TOKEN_2022, isMayhemMode: false, createdAt: t.clock.t, source: 'test', devBuySol: 0, ...extra });
}

export async function launchAndPump(t) {
  await launch(t);
  // early buyers, then a steady climb from many different wallets while the bot studies it
  for (let i = 0; i < 6; i++) { await t.othersBuy(0.6); await t.step(); }
  for (let i = 0; i < 40 && t.bot.positions.size === 0; i++) { await t.othersBuy(0.3); await t.othersBuy(0.25); await t.step(); await t.settle(); }
}

