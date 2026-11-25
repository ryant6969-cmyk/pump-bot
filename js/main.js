// Starts the app: loads saved data, starts the bot engine, draws the screen,
// keeps the screen awake while the bot works, and catches up after the app
// returns from the background.

import { Store, requestPersistentStorage } from './store.js';
import { Bot } from './bot.js';
import { UI, esc } from './ui.js';

const VERSION = '2.0.1';

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

async function main() {
  const store = new Store();
  requestPersistentStorage();
  const bot = new Bot({ store });
  await bot.init();
  let ui;
  const wake = new WakeLock(() => ui?.scheduleUpdate());
  ui = new UI(bot, { wake, store, version: VERSION });
  ui.mount();
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
  });
  window.addEventListener('pageshow', (e) => { if (e.persisted) bot.onResume(60000); });
  window.addEventListener('online', () => bot.onResume(60000));
}

main().catch((e) => {
  console.error(e);
  const boot = document.getElementById('boot');
  if (boot) {
    boot.hidden = false;
    boot.innerHTML = `<p style="padding:24px;text-align:center">Win Bot couldn't start: ${esc(e?.message || e)}<br><br>Try closing and reopening it. Your wallet is safe on this phone.</p>`;
  }
});
