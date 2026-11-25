// Full run of the real app in Chrome at iPhone 18 Pro Max size, against the
// fake Solana network (test/mockchain.mjs) and fake live feeds.
// Usage: node test/e2e.mjs   (screenshots go to test/screens/)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import nodeCrypto from 'node:crypto';
import { MockChain, encodeTokenAccount, encodeTradeEvent, pumpLogs } from './mockchain.mjs';
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
function createEvent(mint, curve, creator, name, symbol, mayhem) {
  return concat(Uint8Array.from([27, 114, 169, 77, 222, 235, 99, 118]), bstr(name), bstr(symbol), bstr('https://x'),
    b58decode(mint), b58decode(curve), b58decode(creator), b58decode(creator), u64le(1n),
    u64le(pump.INITIAL_VIRTUAL_TOKEN_RESERVES), u64le(pump.INITIAL_VIRTUAL_SOL_RESERVES), u64le(pump.INITIAL_REAL_TOKEN_RESERVES), u64le(10n ** 15n),
    b58decode(pump.TOKEN_2022), Uint8Array.of(mayhem ? 1 : 0, 0));
}

// live sockets: every logsSubscribe gets its own id; trades go to whoever watches that address
const subsByAddr = new Map();
let nextSub = 100;
function notify(address, logs) {
  for (const { ws, id } of subsByAddr.get(address) || []) {
    try { ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'logsNotification', params: { subscription: id, result: { context: { slot: 1 }, value: { signature: b58encode(nodeCrypto.randomBytes(64)), err: null, logs } } } })); } catch {}
  }
}

const coins = new Map(); // mint -> { name, symbol, trend, curveAddr, creator, born }
let agentAddr = null;
async function launch(name, symbol, trend, { mayhem = false, devBuy = 0 } = {}) {
  const mint = b58encode(nodeCrypto.randomBytes(32));
  const { curveAddr, curveAta, creator } = await chain.addCoin({ mint, curve: { isMayhemMode: mayhem } });
  const k = { name, symbol, trend, curveAddr, curveAta, creator, mayhem, born: Date.now(), devBuy };
  coins.set(mint, k);
  if (devBuy) k.devEvent = await chain.trade(mint, { user: creator, sol: devBuy });
  return mint;
}
async function trade(mint, opts) {
  const k = coins.get(mint);
  const c = pump.decodeBondingCurve(chain.get(k.curveAddr).data);
  if (c.complete || (opts.isBuy !== false && c.realTokenReserves < 50_000_000_000_000n)) return null;
  const ev = await chain.trade(mint, opts);
  notify(k.curveAddr, pumpLogs([ev]));
  if (opts.user) notify(opts.user, pumpLogs([ev]));
  return ev;
}
const othersBuy = (mint, sol, user) => trade(mint, { sol, user });

let market = null;
function startMarket() {
  let busy = false;
  market = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      for (const [mint, k] of coins) {
        const age = (Date.now() - k.born) / 1000;
        if (k.trend === 'moon') { await othersBuy(mint, 0.2 + Math.random() * 0.25); await othersBuy(mint, 0.15 + Math.random() * 0.2); }
        else if (k.trend === 'flat') { if (Math.random() < 0.3) await othersBuy(mint, 0.05); }
        else if (k.trend === 'rug') {
          if (age < 22) await othersBuy(mint, 0.35);
          else if (!k.rugged) { k.rugged = true; await trade(mint, { user: k.creator, isBuy: false }); }
          else if (Math.random() < 0.5) await othersBuy(mint, 0.05);
        } else if (k.trend === 'agent') {
          await trade(mint, { user: agentAddr, sol: 0.3 });
          if (Math.random() < 0.5) await trade(mint, { user: agentAddr, isBuy: false, tokens: 6_000_000_000_000n });
          if (age < 6) await othersBuy(mint, 0.4);
        }
      }
    } finally { busy = false; }
  }, 1000);
}

async function main() {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    viewport: { width: 440, height: 956 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1',
    colorScheme: 'light',
    serviceWorkers: 'block',
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
      if (j.method === 'logsSubscribe') {
        const id = nextSub++;
        const a = j.params[0].mentions[0];
        if (!subsByAddr.has(a)) subsByAddr.set(a, []);
        subsByAddr.get(a).push({ ws, id });
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: id }));
      } else if (j.method === 'logsUnsubscribe') {
        for (const [a, list] of subsByAddr) subsByAddr.set(a, list.filter((x) => !(x.ws === ws && x.id === j.params[0])));
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: true }));
      }
    });
  });
  await page.routeWebSocket('wss://pumpportal.fun/api/data', (ws) => {
    sockets.portal.push(ws);
    ws.onMessage((m) => { if (JSON.parse(m).method === 'subscribeNewToken') ws.send(JSON.stringify({ message: 'Successfully subscribed to token creation events.' })); });
  });
  const MINT_AUTH = await pump.mintAuthorityAddress();
  agentAddr = await pump.mayhemAgentAddress();
  const announce = async (mint) => {
    const k = coins.get(mint);
    const events = [createEvent(mint, k.curveAddr, k.creator, k.name, k.symbol, k.mayhem)];
    if (k.devEvent) events.push(encodeTradeEvent(k.devEvent));
    notify(MINT_AUTH, pumpLogs(events));
    for (const ws of sockets.portal) ws.send(JSON.stringify({ signature: 'x', mint, traderPublicKey: k.creator, txType: 'create', name: k.name, symbol: k.symbol, pool: 'pump' }));
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
  const rug = await launch('Mangy Wad', 'MANGY', 'rug', { devBuy: 1.5 });
  await announce(rug);
  const agentCoin = await launch('Agent Only', 'AGNT', 'agent', { mayhem: true });
  await announce(agentCoin);
  await sleep(16000);
  await shot('09-home-studying');
  await tap('[data-action="tab"][data-tab="coins"]');
  await shot('10-coins-studying');
  await tap(`[data-action="coin"][data-mint="${moon}"]`);
  await sleep(600);
  await shot('11-coin-sheet-studying');
  await tap('.sheet [data-action="close-sheet"]');
  await tap('[data-action="tab"][data-tab="home"]');
  log('waiting for the practice buy (after a 45 s study)…');
  await page.waitForFunction(() => document.querySelectorAll('[data-action="pos"]').length > 0, null, { timeout: 120_000 });
  await shot('12-home-practice-holding');
  const homeText = await page.locator('.balance').textContent();
  log('home shows dollars:', /\$\d/.test(homeText) && /Today [+−]?\$/.test(homeText) ? 'ok' : 'UNEXPECTED ' + homeText);
  if (!/Today [+−]?\$/.test(homeText)) errors.push('home does not show profit in dollars');
  const rowText = await page.locator('.posrow').first().textContent();
  log('open trade row:', rowText.replace(/\s+/g, ' ').trim());
  await tap('[data-action="tab"][data-tab="trades"]');
  await shot('13-trades-open');
  log('waiting for take profit…');
  await page.waitForFunction(() => !document.querySelector('.pos'), null, { timeout: 150_000 });
  await tap('[data-action="trades-view"][data-view="history"]');
  await shot('14-trades-history');
  await tap('[data-action="tab"][data-tab="coins"]');
  await shot('15-coins-studied');
  await tap(`[data-action="coin"][data-mint="${rug}"]`);
  await sleep(500);
  await shot('16-coin-sheet-mangy');
  const rugSheet = await page.locator('.sheet').textContent();
  log('MANGY verdict:', /Creator is selling/.test(rugSheet) ? 'rejected: creator is selling' : 'UNEXPECTED: ' + rugSheet.slice(0, 300));
  if (!/Creator is selling/.test(rugSheet)) errors.push('MANGY coin was not rejected for the creator selling');
  await tap('.sheet [data-action="close-sheet"]');
  await tap(`[data-action="coin"][data-mint="${whale}"]`);
  await sleep(500);
  await shot('17-coin-sheet-whale');
  await tap('.sheet [data-action="close-sheet"]');

  // ---------- wallet tracker & copy trading (practice) ----------
  const leader = b58encode(nodeCrypto.randomBytes(32));
  await tap('[data-action="tab"][data-tab="wallets"]');
  await shot('18-wallets-empty');
  await page.fill('#track-input', 'https://pump.fun/profile/' + leader);
  await tap('[data-action="track"]');
  await page.waitForSelector('.wallet');
  await tap(`[data-wallet-copy="${leader}"]`);
  await tap('[data-dlg="yes"]');
  await page.waitForSelector('.copybox.on');
  const copyCoin = await launch('Copy Cat', 'COPY', 'flat');
  await announce(copyCoin);
  await sleep(1500);
  await othersBuy(copyCoin, 0.8);
  const leaderBuy = await trade(copyCoin, { user: leader, sol: 1.2 });
  log('leader bought', leaderBuy ? 'ok' : 'failed');
  await page.waitForFunction(() => [...document.querySelectorAll('.wtrade .note')].some((n) => /Copied/.test(n.textContent)), null, { timeout: 20_000 });
  await shot('19-wallets-copied');
  await tap('[data-action="tab"][data-tab="trades"]');
  await tap('[data-action="trades-view"][data-view="open"]');
  await shot('20-trades-copy-open');
  await trade(copyCoin, { user: leader, isBuy: false });
  await page.waitForFunction(() => !document.querySelector('.pos .badge.copy'), null, { timeout: 20_000 });
  log('copied trade closed after the leader sold');
  await tap('[data-action="tab"][data-tab="wallets"]');
  await tap(`[data-wallet-copy="${leader}"]`); // copying off again
  await sleep(300);

  // ---------- real money ----------
  await tap('[data-action="tab"][data-tab="home"]');
  await tap('[data-action="power"]'); // stop
  await tap('[data-action="mode-sheet"]');
  await shot('21-mode-sheet');
  await tap('[data-action="set-mode"][data-mode="real"]');
  await tap('[data-dlg="yes"]');
  // fund the bot wallet from "Phantom", using the address shown in the app
  await tap('[data-action="deposit"]');
  const pubkey = (await page.locator('.sheet .mono').first().textContent()).trim();
  log('bot wallet address from the app:', pubkey);
  chain.addWallet(pubkey, 0.5);
  await sleep(1500);
  await shot('22-deposit-sheet');
  await tap('.sheet [data-action="close-sheet"]');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await sleep(1500);
  await tap('[data-action="power"]');
  await tap('[data-dlg="yes"]');
  await page.waitForFunction(() => document.querySelector('.power.on'), null, { timeout: 10_000 });
  const moon2 = await launch('Laser Frog', 'LFROG', 'moon');
  await announce(moon2);
  log('waiting for the real buy (after a 45 s study)…');
  await page.waitForFunction(() => document.querySelectorAll('[data-action="pos"]').length > 0, null, { timeout: 120_000 });
  await shot('23-home-real-holding');
  const { associatedTokenAddress } = await import('../js/pda.js');
  const held = [];
  for (const [mint, k] of coins) { const amt = chain.tokenAmount(await associatedTokenAddress(pubkey, mint, pump.TOKEN_2022)); if (amt > 0n) held.push(k.symbol + '=' + amt); }
  log('real coins held on chain after the buy:', held.join(', ') || 'none');
  const ata = await associatedTokenAddress(pubkey, [...coins.keys()].find((m) => held.some((h) => h.startsWith(coins.get(m).symbol + '='))) || moon2, pump.TOKEN_2022);
  await tap('[data-action="tab"][data-tab="trades"]');
  await tap('[data-action="trades-view"][data-view="open"]');
  await shot('24-trades-real-open');
  // sell half by hand, then the rest
  const tokensBefore = chain.tokenAmount(ata);
  await tap('[data-action="sell-part"][data-fraction="0.5"]');
  await tap('[data-dlg="yes"]');
  await page.waitForFunction(() => document.querySelector('.pos') && !document.querySelector('.sellrow .btn[disabled]'), null, { timeout: 30_000 });
  await sleep(500);
  const tokensHalf = chain.tokenAmount(ata);
  log('sold half by hand:', tokensHalf > 0n && tokensHalf * 100n < tokensBefore * 55n && tokensHalf * 100n > tokensBefore * 45n ? 'ok' : `UNEXPECTED ${tokensHalf} of ${tokensBefore}`);
  if (!(tokensHalf * 100n < tokensBefore * 55n && tokensHalf * 100n > tokensBefore * 45n)) errors.push('partial sell did not sell half');
  await shot('24b-trades-after-half');
  await tap('[data-action="sell"]');
  await tap('[data-dlg="yes"]');
  await page.waitForFunction(() => !document.querySelector('.pos'), null, { timeout: 30_000 });
  log('tokens on chain after sell:', chain.tokenAmount(ata).toString(), 'sol:', Number(chain.lamports(pubkey)) / 1e9);
  await tap('[data-action="trades-view"][data-view="history"]');
  await shot('25-trades-real-history');
  await tap('[data-action="tab"][data-tab="home"]');
  await shot('26-home-real');
  // withdraw
  await tap('[data-action="tab"][data-tab="settings"]');
  await tap('[data-action="withdraw"]');
  const phantom = b58encode(nodeCrypto.randomBytes(32));
  await page.fill('#wd-to', phantom);
  await tap('[data-action="wd-max"]');
  await shot('27-withdraw');
  await tap('[data-action="wd-go"]');
  await tap('[data-dlg="yes"]');
  await sleep(2500);
  log('phantom received SOL:', Number(chain.lamports(phantom)) / 1e9);
  await tap('[data-action="tab"][data-tab="home"]');
  await tap('[data-action="power"]');
  await shot('28-home-after-withdraw');
  await tap('[data-action="tab"][data-tab="settings"]');
  await page.evaluate(() => window.scrollTo(0, 700));
  await shot('29-settings-study');
  await tap('[data-action="help"]');
  await shot('30-help');

  clearInterval(market);
  await browser.close();
  const real = errors.filter((e) => !/Failed to load resource|net::ERR_FAILED/.test(e));
  log('page errors:', real.length ? real : 'none');
  log('mock calls:', Object.entries(chain.calls.reduce((m, c) => ((m[c] = (m[c] || 0) + 1), m), {})).map(([k, v]) => k + '=' + v).join(' '));
  if (real.length) process.exitCode = 1;
}

main().catch((e) => { console.error('E2E FAILED:', e); process.exitCode = 1; clearInterval(market); });
