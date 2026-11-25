# Win Bot

A pump.fun trading bot that runs on your iPhone. It's a Home Screen web app, so there's nothing to install and no server to run.

- **Practice first:** it starts with pretend SOL on real live coins.
- **It studies before it buys:** for 45 seconds it reads every trade on a promising coin (real buyers, money in and out, whales, whether the creator is selling) and scores it out of 100. Only strong coins get bought.
- **It watches what it holds:** it sells right away if the creator starts selling, a big holder dumps, or sellers take over.
- **Wallet tracker and copy trading:** follow any trader by wallet address, pump.fun profile link or @username, and optionally copy their trades.
- **Your keys stay on the phone:** the bot has its own wallet, stored only on your iPhone. Trades go straight from the phone to Solana.

> Memecoins are extremely risky and most go to zero. No bot wins every trade. Only use SOL you can afford to lose. Not financial advice.

## Set it up (iPhone)

1. Open the app's link in **Safari**, tap **Share**, then **Add to Home Screen**. Open Win Bot from the Home Screen.
2. **Connect to Solana:** make a free account at [dashboard.helius.dev](https://dashboard.helius.dev/), copy your API key and paste it in.
3. **Wallet:** tap *Create a new wallet*, then save the backup key in your password manager.
4. **Pick a style** (Careful, Balanced or Aggressive) and tap **Start**. You're in Practice mode.
5. When you're ready for real money: Settings → Mode → **Real money**, tap **Add SOL** and send a small amount from Phantom, then tap **Start**.

**Keep the app open while it trades.** iPhone pauses web apps in the background, so the bot only trades while Win Bot is on screen. It keeps the screen awake by itself, so plug the phone in. When you come back after leaving, it immediately checks your trades and sells anything that hit a rule.

## How it trades

| | Careful | Balanced | Aggressive |
|---|---|---|---|
| SOL per trade | 0.02 | 0.05 | 0.1 |
| Trades at once | 1 | 2 | 3 |
| Score needed to buy | 78 | 70 | 62 |
| Real buyers needed in the study | 12 | 8 | 6 |
| Net SOL coming in during the study | 1.5 | 1.0 | 0.6 |
| Price rise during the study | +15% | +10% | +7% |
| Take profit | +30% | +45% | +90% |
| Stop loss | −15% | −18% | −25% |
| Trailing stop | after +20%, on a 10% drop | after +25%, on a 12% drop | after +35%, on a 15% drop |
| Time limit | 6 min | 10 min | 15 min |
| Stops buying for the day after losing | 0.1 SOL | 0.25 SOL | 0.5 SOL |

**Scans** every new coin's bonding curve and picks the ones with SOL coming in, priced above launch and not falling, for a **study**: it subscribes to the coin's live trades and reads them for 45 seconds (25 for mayhem coins). Wallets that keep buying and selling (volume bots) and pump.fun's mayhem agent don't count as real buyers.

**Rejects** a coin if the creator is selling, there are too few real buyers, more selling than buying, too little money coming in, one wallet doing most of the buying, the price isn't climbing, it's already well off its high, it has too little SOL in it, or it isn't clearly above its launch price. Otherwise it gets a score out of 100 (real buyers 25, money in 20, buy pressure 15, momentum 15, spread 10, holding up 10, creator 5). A coin that passes then needs spread-out holders (the curve and the mayhem agent's vault excluded). After losses in a row, coins need up to 15 more points until the next win.

**Mayhem coins** are allowed, but need more real buyers, a stronger score and a price that is clearly still climbing. The bot takes a quick $5 profit on them, or holds for up to $10 while the coin keeps flying.

**Sells** right away if the creator sells, a big holder dumps, or sellers take over; otherwise on take profit, stop loss, trailing stop, time limit, if the coin goes nowhere, at 95% of the curve (optional), or if it graduates to PumpSwap. Sales are retried until they land, with more slippage each time if the price is moving fast. Coins the bot didn't buy are never sold unless you tap Sell.

**Copy trading** (Wallets tab): when a tracked trader buys a pump.fun coin, the bot buys your set amount of it, unless the price already ran up 25% since their buy. When they sell, it sells the same share. Copied trades keep your stop loss and the creator/dump protections; take profit and time limits are left to the trader you copy. Copies only run while the bot is started.

Every setting can be changed in the app.

## Safety built in

- Every real transaction is **test-run on the network first**. The bot reads exactly how the wallet's SOL and coins would change, and cancels anything that would spend more than the trade should.
- Trades are built directly from pump.fun's published program layout (`buy_exact_quote_in_v3`, `sell_v3`, PumpSwap `sell_v2`). Buys never use anything else: if a buy fails, nothing is bought.
- Sells have one last-resort fallback so a coin never gets stuck: PumpPortal's transaction builder (0.5% fee). The bot only signs it if every instruction is one of a few exact shapes (one sell of this coin by this wallet with real price protection, at most a 0.6% fee, no approvals, no transfers of coins, no account reassignments, a normal recent blockhash), and the same test-run passes.
- Sells never wait behind a buy. Trades that are still unconfirmed when the app closes, or whose status couldn't be checked, are re-checked when it opens again, and a buy that landed late is adopted as a normal bot trade.
- Sell slippage only widens after the price actually moved away; a double tap can't buy the same coin twice.
- Daily loss limit, a cap on open trades, and buying pauses after 3 failed buys in a row.
- Real mode never auto-starts: after the app restarts, open trades keep being managed, but buying waits for you to tap Start.

## Hosting note

The wallet key is stored in the browser storage of the site that serves the app. On GitHub Pages, every project site under `yourname.github.io` shares that storage, so keep Win Bot the only site published under that address (or host it on its own domain).

## Costs

pump.fun's trading fee (about 1.25% per trade), the Solana network fee (about 0.0001–0.0005 SOL per trade depending on Speed), and about 0.002 SOL the first time each coin is bought, for its token account. The bot closes that account after selling and gets the 0.002 SOL back. Helius's free plan (1M credits a month, 10 requests a second) covers normal use.

## For developers

Plain HTML, CSS and JavaScript modules with no dependencies and no build step. Host the folder on any static HTTPS host (GitHub Pages works).

| File | What it does |
|---|---|
| `js/bot.js` | The engine: scanning, studies, buy/sell decisions, positions, copy trading, limits, recovery |
| `js/analyst.js` | The study: live trade tape, real-buyer counting, scoring and red flags, live exit signals |
| `js/strategy.js` | The three styles, which coins get studied, the holder check and the sell rules |
| `js/wallets.js` | Wallet tracker input (address, profile link, @username) and trade parsing |
| `js/trader.js` | Real trades: build, test-run, safety check, sign, send, confirm |
| `js/pump.js` | pump.fun accounts, price math and instructions |
| `js/feeds.js` | Live new-coin feed (Solana logs + PumpPortal) |
| `js/rpc.js` | Solana RPC with rate limiting, and one live WebSocket carrying every log subscription |
| `js/tx.js`, `js/keys.js`, `js/ed25519.js`, `js/pda.js`, `js/b58.js` | Solana transactions, keys and addresses, written from scratch |
| `js/ui.js`, `js/main.js`, `css/app.css` | The iPhone app |

Tests (Node 22+): `node --test test/*.test.mjs`. They check signatures against Node's native Ed25519, addresses against ones pump.fun publishes, and run full trades against a fake Solana network (`test/mockchain.mjs`) that validates every pump.fun account against the official IDL. `node test/e2e.mjs` drives the whole app in Chrome at iPhone size (needs Playwright).
