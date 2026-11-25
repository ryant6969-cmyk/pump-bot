// New-coin feed: both sources, de-duplication, reconnects.
import test from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';

import { b58decode, b58encode } from '../js/b58.js';
import { concat, toBase64, u32le, u64le } from '../js/bytes.js';
import { CoinFeed, coinFromPumpPortal } from '../js/feeds.js';
import * as pump from '../js/pump.js';
import { normalizeRpcInput } from '../js/rpc.js';

class FakeWS {
  static all = [];
  constructor(url) { this.url = url; this.sent = []; this.closed = false; FakeWS.all.push(this); }
  send(d) { this.sent.push(JSON.parse(d)); }
  close() { if (this.closed) return; this.closed = true; this.onclose?.(); }
  open() { this.onopen?.(); }
  msg(o) { this.onmessage?.({ data: JSON.stringify(o) }); }
}

function bstr(s) { const b = new TextEncoder().encode(s); return concat(u32le(b.length), b); }
async function createLogs(mint, name, symbol) {
  const curve = await pump.bondingCurveAddress(mint);
  const creator = b58encode(nodeCrypto.randomBytes(32));
  const ev = concat(Uint8Array.from([27, 114, 169, 77, 222, 235, 99, 118]), bstr(name), bstr(symbol), bstr('https://x'),
    b58decode(mint), b58decode(curve), b58decode(creator), b58decode(creator), u64le(1n), u64le(1n), u64le(1n), u64le(1n), u64le(1n), b58decode(pump.TOKEN_2022), Uint8Array.of(1, 0));
  return [`Program ${pump.PUMP} invoke [1]`, `Program data: ${toBase64(ev)}`, `Program ${pump.PUMP} success`];
}

test('normalizeRpcInput accepts Helius keys and https URLs only', () => {
  const key = '1a2b3c4d-1111-2222-3333-444455556666';
  assert.deepEqual(normalizeRpcInput(key), { http: `https://mainnet.helius-rpc.com/?api-key=${key}`, ws: `wss://mainnet.helius-rpc.com/?api-key=${key}`, label: 'Helius' });
  assert.equal(normalizeRpcInput(' https://mainnet.helius-rpc.com/?api-key=' + key + ' ').ws, `wss://mainnet.helius-rpc.com/?api-key=${key}`);
  assert.equal(normalizeRpcInput('mainnet.helius-rpc.com/?api-key=' + key).label, 'Helius');
  assert.equal(normalizeRpcInput('api-key=' + key).http, `https://mainnet.helius-rpc.com/?api-key=${key}`);
  assert.equal(normalizeRpcInput('https://solana-mainnet.g.alchemy.com/v2/abc').ws, 'wss://solana-mainnet.g.alchemy.com/v2/abc');
  assert.equal(normalizeRpcInput('http://insecure.example.com'), null);
  assert.equal(normalizeRpcInput('https://api.devnet.solana.com'), null);
  assert.equal(normalizeRpcInput('hello'), null);
  assert.equal(normalizeRpcInput(''), null);
});

test('PumpPortal create messages are validated and cleaned', () => {
  const mint = b58encode(nodeCrypto.randomBytes(32));
  assert.equal(coinFromPumpPortal({ txType: 'buy', mint }), null);
  assert.equal(coinFromPumpPortal({ txType: 'create', mint: 'bad' }), null);
  assert.equal(coinFromPumpPortal({ txType: 'create', mint, pool: 'bonk' }), null);
  const c = coinFromPumpPortal({ txType: 'create', mint, name: '<b>Hi</b>‮', symbol: 'HI', traderPublicKey: 'x' }, 5);
  assert.equal(c.name, '<b>Hi</b>');
  assert.equal(c.creator, null);
  assert.equal(c.createdAt, 5);
});

test('both sources feed coins; duplicates are dropped; dead sockets reconnect', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  FakeWS.all = [];
  const coins = [];
  const statuses = [];
  const feed = new CoinFeed({ wsUrl: 'wss://rpc.test/?api-key=k', WebSocketImpl: FakeWS, onCoin: (c) => coins.push(c), onStatus: (s) => statuses.push({ ...s }) });
  await feed.start();
  const chainWs = FakeWS.all.find((w) => w.url.startsWith('wss://rpc.test'));
  const portalWs = FakeWS.all.find((w) => w.url === 'wss://pumpportal.fun/api/data');
  assert.ok(chainWs && portalWs);
  chainWs.open();
  assert.deepEqual(chainWs.sent[0].params[0], { mentions: ['TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM'] });
  chainWs.msg({ jsonrpc: '2.0', id: 1, result: 42 });
  assert.equal(feed.status.chain, 'live');
  portalWs.open();
  assert.deepEqual(portalWs.sent[0], { method: 'subscribeNewToken' });
  const mint = b58encode(nodeCrypto.randomBytes(32));
  chainWs.msg({ jsonrpc: '2.0', method: 'logsNotification', params: { subscription: 42, result: { value: { signature: 'sig1', err: null, logs: await createLogs(mint, 'Frog', 'FRG') } } } });
  portalWs.msg({ txType: 'create', mint, name: 'Frog', symbol: 'FRG' });
  const mint2 = b58encode(nodeCrypto.randomBytes(32));
  portalWs.msg({ txType: 'create', mint: mint2, name: 'Cat', symbol: 'CAT' });
  // failed transactions are ignored
  chainWs.msg({ jsonrpc: '2.0', method: 'logsNotification', params: { result: { value: { signature: 'sig2', err: { x: 1 }, logs: await createLogs(b58encode(nodeCrypto.randomBytes(32)), 'X', 'X') } } } });
  assert.equal(coins.length, 2);
  assert.equal(coins[0].mint, mint);
  assert.equal(coins[0].source, 'chain');
  assert.equal(coins[0].tokenProgram, pump.TOKEN_2022);
  assert.equal(coins[0].isMayhemMode, true);
  assert.equal(coins[1].symbol, 'CAT');
  assert.ok(feed.isLive());
  // the chain socket drops: it reconnects by itself
  chainWs.close();
  assert.equal(feed.status.chain, 'connecting');
  t.mock.timers.tick(1100);
  const again = FakeWS.all.filter((w) => w.url.startsWith('wss://rpc.test'));
  assert.equal(again.length, 2);
  // a socket that goes silent for 2 minutes is replaced
  again[1].open(); again[1].msg({ jsonrpc: '2.0', id: 1, result: 7 });
  t.mock.timers.tick(130_000);
  assert.ok(again[1].closed);
  feed.stop();
  assert.equal(feed.status.chain, 'off');
  const n = FakeWS.all.length;
  t.mock.timers.tick(120_000);
  assert.equal(FakeWS.all.length, n, 'no reconnects after stop');
});
