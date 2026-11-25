// Full run of the real app in Chrome at iPhone 18 Pro Max size, against the
// fake Solana network (test/mockchain.mjs) and fake live feeds.
// Usage: node test/e2e.mjs   (screenshots go to test/screens/)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import nodeCrypto from 'node:crypto';
import { MockChain, encodeTokenAccount } from './mockchain.mjs';
import { b58decode, b58encode } from '../js/b58.js';
import { concat, toBase64, u32le, u64le } from '../js/bytes.js';
import * as pump from '../js/pump.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const PAGE = process.env.E2E_PAGE || '';
const SHOTS = path.join(ROOT, 'test', 'screens', PAGE ? 'single' : '');
fs.mkdirSync(SHOTS, { recursive: true });
const ORIGIN = 'https://winbot.test';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

const chain = new MockChain();
const errors = [];

function bstr(s) { const b = new TextEncoder().encode(s); return concat(u32le(b.length), b); }
async function createLogs(mint, name, symbol) {
  const curve = await pump.bondingCurveAddress(mint);
  const creator = b58encode(nodeCrypto.randomBytes(32));
  const ev = concat(Uint8Array.from([27, 114, 169, 77, 222, 235, 99, 118]), bstr(name), bstr(symbol), bstr('https://x'),
    b58decode(mint), b58decode(curve), b58decode(creator), b58decode(creator), u64le(1n), u64le(1n), u64le(1n), u64le(1n), u64le(1n), b58decode(pump.TOKEN_2022), Uint8Array.of(0, 0));
  return [`Program ${pump.PUMP} invoke [1]`, 'Program log: Instruction: CreateV2', `Program data: ${toBase64(ev)}`, `Program ${pump.PUMP} success`];
}

const coins = new Map(); // mint -> { name, symbol, trend }
async function launch(name, symbol, trend) {
  const mint = b58encode(nodeCrypto.randomBytes(32));
  const { curveAddr, curveAta } = await chain.addCoin({ mint });
  coins.set(mint, { name, symbol, trend, curveAddr, curveAta, born: Date.now() });
  return mint;
}
async function othersBuy(mint, sol) {
  const k = coins.get(mint);
  const c = pump.decodeBondingCurve(chain.get(k.curveAddr).data);
  const net = BigInt(Math.round(sol * 1e9));
  const out = (net * c.virtualTokenReserves) / (c.virtualQuoteReserves + net);
  if (out <= 0n || out >= c.realTokenReserves) return;
  await chain.setCurve(mint, { virtualQuoteReserves: c.virtualQuoteReserves + net, realQuoteReserves: c.realQuoteReserves + net, virtualTokenReserves: c.virtualTokenReserves - out, realTokenReserves: c.realTokenReserves - out });
  chain.get(k.curveAddr).lamports += net;
  const ataAcc = chain.get(k.curveAta);
  ataAcc.data = encodeTokenAccount(mint, k.curveAddr, pump.decodeTokenAccount(ataAcc.data).amount - out);
  await chain.giveTokens(b58encode(nodeCrypto.randomBytes(32)), mint, out);
}
async function othersSell(mint, fraction) {
  const k = coins.get(mint);
  const c = pump.decodeBondingCurve(chain.get(k.curveAddr).data);
  const q = BigInt(Math.round(Number(c.virtualQuoteReserves) * (1 - fraction)));
  const newT = (c.virtualQuoteReserves * c.virtualTokenReserves) / q;
  await chain.setCurve(mint, { virtualQuoteReserves: q, virtualTokenReserves: newT, realTokenReserves: c.realTokenReserves + (newT - c.virtualTokenReserves) });
}

let market = null;
function startMarket() {
  market = setInterval(async () => {
    for (const [mint, k] of coins) {
      const age = (Date.now() - k.born) / 1000;
      if (k.trend === 'moon') await othersBuy(mint, age < 12 ? 0.5 : 0.7);
      else if (k.trend === 'flat') { if (Math.random() < 0.3) await othersBuy(mint, 0.05); }
      else if (k.trend === 'rug') { if (age < 40) await othersBuy(mint, 0.6); else if (!k.rugged) { k.rugged = true; await othersSell(mint, 0.6); } }
      else if (k.trend === 'pump-hard') await othersBuy(mint, 1.8);
    }
  }, 1000);
}

async function main() {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    viewport: { width: 440, height: 956 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1',
    colorScheme: 'dark',
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
  const page = await context.newPage();
  page.on('pageerror', (e) => { errors.push(String(e)); log('PAGE ERROR', e.message); });
  page.on('console', (m) => { if (m.type() === 'error') { errors.push(m.text()); log('console.error', m.text()); } });

  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === ORIGIN) {
      let p = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = path.join(ROOT, p);
      if (!file.startsWith(ROOT) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: 'nf' });
      return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
    }
    if (url.hostname === 'rpc.test' || url.hostname === 'pumpportal.fun') {
      const req = route.request();
      const res = await chain.fetchImpl(req.url(), { method: req.method(), body: req.postData() });
      if (url.hostname === 'pumpportal.fun') {
        const buf = Buffer.from(await res.arrayBuffer());
        return route.fulfill({ status: res.status, body: buf, headers: { 'access-control-allow-origin': '*' } });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(await res.json()), headers: { 'access-control-allow-origin': '*' } });
    }
    if (url.hostname === 'api.coingecko.com') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"solana":{"usd":150}}', headers: { 'access-control-allow-origin': '*' } });
    return route.abort();
  });

  const sockets = { chain: [], portal: [] };
  await page.routeWebSocket(/wss:\/\/rpc\.test.*/, (ws) => {
    sockets.chain.push(ws);
    ws.onMessage((m) => {
      const j = JSON.parse(m);
      if (j.method === 'logsSubscribe') ws.send(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: 99 }));
    });
  });
  await page.routeWebSocket('wss://pumpportal.fun/api/data', (ws) => {
    sockets.portal.push(ws);
    ws.onMessage((m) => { if (JSON.parse(m).method === 'subscribeNewToken') ws.send(JSON.stringify({ message: 'Successfully subscribed to token creation events.' })); });
  });
  const announce = async (mint) => {
    const k = coins.get(mint);
    for (const ws of sockets.chain) ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'logsNotification', params: { subscription: 99, result: { context: { slot: 1 }, value: { signature: b58encode(nodeCrypto.randomBytes(64)), err: null, logs: await createLogs(mint, k.name, k.symbol) } } } }));
    for (const ws of sockets.portal) ws.send(JSON.stringify({ signature: 'x', mint, traderPublicKey: b58encode(nodeCrypto.randomBytes(32)), txType: 'create', name: k.name, symbol: k.symbol, pool: 'pump' }));
  };

  const shot = async (name) => { await sleep(350); await page.screenshot({ path: path.join(SHOTS, name + '.png') }); log('shot', name); };
  const tap = async (selector) => { await page.locator(selector).first().click(); await sleep(150); };

  // ---------- setup wizard ----------
  await page.goto(ORIGIN + '/' + PAGE);
  await page.waitForSelector('.wiz');
  await shot('01-welcome');
  await tap('[data-action="wiz-next"]');
  await page.fill('#wiz-key', 'https://rpc.test/?api-key=demo');
  await shot('02-data-key');
  await tap('[data-action="wiz-test-key"]');
  await page.waitForSelector('.alert.ok');
  await shot('03-data-key-ok');
  await tap('[data-action="wiz-next"]');
  await shot('04-wallet');
  await tap('[data-action="wiz-create"]');
  await page.waitForSelector('#wiz-backup');
  await shot('05-backup');
  await page.check('#wiz-backup');
  await tap('[data-action="wiz-backup-done"]');
  await shot('06-style');
  await tap('[data-style="aggressive"]');
  await tap('[data-action="wiz-finish"]');
  await page.waitForSelector('.power');
  const address = await page.evaluate(() => JSON.parse(localStorage.getItem('winbot.v1.wallet')));
  log('wallet key saved:', typeof address === 'string' && address.length > 80);
  await shot('07-home-practice');

  // speed the rules up for the test: take profit 40%, sell after 3 min
  await tap('[data-action="tab"][data-tab="settings"]');
  await page.fill('[data-num="takeProfitPct"]', '40');
  await page.locator('[data-num="takeProfitPct"]').blur();
  await sleep(200);
  await shot('08-settings');
  await tap('[data-action="tab"][data-tab="home"]');

  // ---------- practice run ----------
  startMarket();
  await tap('[data-action="power"]');
  await page.waitForFunction(() => document.querySelector('.power.on'));
  await sleep(1500);
  const moon = await launch('Rocket Dog', 'RDOG', 'moon');
  await announce(moon);
  const flat = await launch('Sleepy Cat', 'ZZZ', 'flat');
  await announce(flat);
  const whale = await launch('Whale Coin', 'WHALE', 'moon');
  await chain.giveTokens(b58encode(nodeCrypto.randomBytes(32)), whale, 200_000_000_000_000n);
  await announce(whale);
  await sleep(6000);
  await tap('[data-action="tab"][data-tab="coins"]');
  await shot('09-coins-live');
  await tap('[data-action="tab"][data-tab="home"]');
  log('waiting for the practice buy…');
  await page.waitForFunction(() => document.querySelectorAll('[data-action="pos"]').length > 0, null, { timeout: 90_000 });
  await shot('10-home-practice-holding');
  await tap('[data-action="tab"][data-tab="trades"]');
  await shot('11-trades-open');
  log('waiting for take profit…');
  await page.waitForFunction(() => !document.querySelector('.pos'), null, { timeout: 120_000 });
  await tap('[data-action="trades-view"][data-view="history"]');
  await shot('12-trades-history');
  await tap('[data-action="tab"][data-tab="coins"]');
  await tap(`[data-action="coin"][data-mint="${whale}"]`);
  await shot('13-coin-sheet-whale');
  await tap('.sheet [data-action="close-sheet"]');

  // ---------- real money ----------
  await tap('[data-action="tab"][data-tab="home"]');
  await tap('[data-action="power"]'); // stop
  await tap('[data-action="mode-sheet"]');
  await shot('14-mode-sheet');
  await tap('[data-action="set-mode"][data-mode="real"]');
  await tap('[data-dlg="yes"]');
  // fund the bot wallet from "Phantom", using the address shown in the app
  await tap('[data-action="deposit"]');
  const pubkey = (await page.locator('.sheet .mono').first().textContent()).trim();
  log('bot wallet address from the app:', pubkey);
  chain.addWallet(pubkey, 0.5);
  await sleep(1500);
  await shot('15-deposit-sheet');
  await tap('.sheet [data-action="close-sheet"]');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await sleep(1500);
  await tap('[data-action="power"]');
  await tap('[data-dlg="yes"]');
  await page.waitForFunction(() => document.querySelector('.power.on'), null, { timeout: 10_000 });
  const moon2 = await launch('Laser Frog', 'LFROG', 'moon');
  await announce(moon2);
  log('waiting for the real buy…');
  await page.waitForFunction(() => document.querySelectorAll('[data-action="pos"]').length > 0, null, { timeout: 90_000 });
  await shot('16-home-real-holding');
  const { associatedTokenAddress } = await import('../js/pda.js');
  const held = [];
  for (const [mint, k] of coins) { const amt = chain.tokenAmount(await associatedTokenAddress(pubkey, mint, pump.TOKEN_2022)); if (amt > 0n) held.push(k.symbol + '=' + amt); }
  log('real coins held on chain after the buy:', held.join(', ') || 'none');
  const ata = await associatedTokenAddress(pubkey, [...coins.keys()].find((m) => held.some((h) => h.startsWith(coins.get(m).symbol + '='))) || moon2, pump.TOKEN_2022);
  await tap('[data-action="tab"][data-tab="trades"]');
  await tap('[data-action="trades-view"][data-view="open"]');
  await shot('17-trades-real-open');
  // sell by hand
  await tap('[data-action="sell"]');
  await tap('[data-dlg="yes"]');
  await page.waitForFunction(() => !document.querySelector('.pos'), null, { timeout: 30_000 });
  log('tokens on chain after sell:', chain.tokenAmount(ata).toString(), 'sol:', Number(chain.lamports(pubkey)) / 1e9);
  await tap('[data-action="trades-view"][data-view="history"]');
  await shot('18-trades-real-history');
  await tap('[data-action="tab"][data-tab="home"]');
  await shot('19-home-real');
  // withdraw
  await tap('[data-action="tab"][data-tab="settings"]');
  await tap('[data-action="withdraw"]');
  const phantom = b58encode(nodeCrypto.randomBytes(32));
  await page.fill('#wd-to', phantom);
  await tap('[data-action="wd-max"]');
  await shot('20-withdraw');
  await tap('[data-action="wd-go"]');
  await tap('[data-dlg="yes"]');
  await sleep(2500);
  log('phantom received SOL:', Number(chain.lamports(phantom)) / 1e9);
  await tap('[data-action="tab"][data-tab="home"]');
  await tap('[data-action="power"]');
  await shot('21-home-after-withdraw');
  await tap('[data-action="tab"][data-tab="settings"]');
  await tap('[data-action="help"]');
  await shot('22-help');

  clearInterval(market);
  await browser.close();
  const real = errors.filter((e) => !/Failed to load resource|net::ERR_FAILED/.test(e));
  log('page errors:', real.length ? real : 'none');
  log('mock calls:', Object.entries(chain.calls.reduce((m, c) => ((m[c] = (m[c] || 0) + 1), m), {})).map(([k, v]) => k + '=' + v).join(' '));
  if (real.length) process.exitCode = 1;
}

main().catch((e) => { console.error('E2E FAILED:', e); process.exitCode = 1; clearInterval(market); });
