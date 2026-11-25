// Starts the app: loads saved data, starts the bot engine, draws the screen,
// keeps the screen awake while the bot works, and catches up after the app
// returns from the background.

import { Store, requestPersistentStorage } from './store.js?v=2.3.0';
import { Bot } from './bot.js?v=2.3.0';
import { UI, esc } from './ui.js?v=2.3.0';

const VERSION = '2.3.0';

class WakeLock {
  constructor(onChange) { this.lock = null; this.onChange = onChange; }
  supported() { return 'wakeLock' in navigator; }
  held() { return !!this.lock; }
  async request() {
    if (!this.supported() || this.lock || document.visibilityState !== 'visible') return !!this.lock;
    try {
      this.lock = await navigator.wakeLock.request('screen');
      this.lock.addEventListener('release', () => { this.lock = null; this.onChange(); });
    } catch {
      this.lock = null;
    }
    this.onChange();
    return !!this.lock;
  }
  async release() {
    const l = this.lock;
    this.lock = null;
    try { await l?.release(); } catch {}
    this.onChange();
  }
}

/**
 * Updates: a service worker always fetches the newest files when online (so
 * a fresh launch is never stuck on an old version), and the app checks for a
 * new version when it starts, when it comes back to the screen and every few
 * minutes. It updates by itself when nothing is running; otherwise it asks.
 */
function registerServiceWorker() {
  const secure = location.protocol === 'https:' || location.hostname === 'localhost';
  if (!('serviceWorker' in navigator) || !secure || !/\/(index\.html)?$/.test(location.pathname)) return null;
  return navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => null);
}

function makeUpdater(bot, ui, store, swReady) {
  let checking = false;
  let offered = null;
  const reloadNow = async () => {
    if (bot.running) store.save('resumeAfterUpdate', { at: Date.now() });
    bot._save();
    try { const reg = await swReady; await reg?.update(); } catch {}
    location.reload();
  };
  const check = async () => {
    if (checking || document.visibilityState !== 'visible') return;
    checking = true;
    try {
      const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return;
      const latest = String((await r.json())?.version || '');
      if (!latest || latest === VERSION) return;
      const busy = bot.draining || bot.buyInFlight || [...bot.positions.values()].some((p) => p.state === 'selling');
      if (busy) { setTimeout(check, 15000); return; } // never in the middle of a trade
      // never loop: reload by itself at most once per new version; after that, offer a button
      const tried = store.load('updateTried', null);
      const triedRecently = tried && tried.v === latest && Date.now() - tried.at < 10 * 60_000;
      if (!triedRecently) {
        store.save('updateTried', { v: latest, at: Date.now() });
        ui.toast('Updating Win Bot…');
        setTimeout(reloadNow, 800);
        return;
      }
      if (offered === latest) return;
      offered = latest;
      ui.offerUpdate(latest, async () => {
        for (let i = 0; i < 40 && (bot.draining || bot.buyInFlight || [...bot.positions.values()].some((p) => p.state === 'selling')); i++) await new Promise((res) => setTimeout(res, 250));
        store.save('updateTried', null);
        await reloadNow();
      });
    } catch { /* offline: try later */ } finally {
      checking = false;
    }
  };
  setTimeout(check, 3000);
  setInterval(check, 2 * 60_000);
  return check;
}

async function main() {
  const store = new Store();
  requestPersistentStorage();
  const swReady = registerServiceWorker();
  const bot = new Bot({ store });
  await bot.init();
  let ui;
  const wake = new WakeLock(() => ui?.scheduleUpdate());
  ui = new UI(bot, { wake, store, version: VERSION });
  ui.mount();
  window.__winbotStarted = true;
  const checkForUpdate = makeUpdater(bot, ui, store, swReady);
  if (bot.resumeAfterUpdate) {
    try { await bot.start(); await wake.request(); ui.toast(`Updated to ${VERSION}. The bot is running again.`); } catch { /* the user can tap Start */ }
    ui.scheduleUpdate();
  }
  // iOS only shows :active (pressed) styles when a touch listener exists.
  document.addEventListener('touchstart', () => {}, { passive: true });

  // Let go of the screen once there's nothing to do.
  bot.addEventListener('change', () => {
    if (!bot.running && bot.positions.size === 0 && wake.held()) wake.release();
  });

  let hiddenAt = 0;
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
    const away = hiddenAt ? Date.now() - hiddenAt : 0;
    hiddenAt = 0;
    if (bot.running || bot.positions.size) {
      await wake.request();
      if (away > 5000) ui.toast('Welcome back. Checking your trades now.');
    }
    bot.onResume(away);
    ui.scheduleUpdate();
    checkForUpdate();
  });
  window.addEventListener('pageshow', (e) => { if (e.persisted) bot.onResume(60000); });
  window.addEventListener('online', () => bot.onResume(60000));
}

main().catch((e) => {
  console.error(e);
  window.__winbotFailed = true;
  const boot = document.getElementById('boot');
  if (boot) {
    boot.hidden = false;
    boot.innerHTML = `<p style="padding:24px;text-align:center">Win Bot couldn't start: ${esc(e?.message || e)}<br><br>Your wallet is safe on this phone.</p><button class="btn go" style="width:auto;padding:0 28px" id="boot-retry">Reload</button>`;
    document.getElementById('boot-retry')?.addEventListener('click', () => location.reload());
  }
});
