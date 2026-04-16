# Polymarket Paper Copytrade Bot

Tracks whale wallets on Polymarket and paper-trades every move they make. Telegram alerts on every copied trade + PnL tracking when markets resolve.

## Setup

```bash
cd polymarket-copytrade
npm install
cp .env.example .env
```

Edit `.env` with your Telegram credentials.

## Add Wallets

Open `index.js` and fill the `WALLETS` array:

```js
const WALLETS = [
  { address: "0xABC123...", nickname: "whale1" },
  { address: "0xDEF456...", nickname: "bigbrain" },
];
```

## Run

```bash
node index.js
```

## Telegram Commands

- `/stats` — paper PnL summary, win rate, open/closed positions
- `/wallets` — list tracked wallets

## Go Live

When you're ready to trade real money:
1. Set `PAPER_MODE=false` in `.env`
2. Add your Polymarket API key + wallet integration (CLOB API)
3. Replace the paper logging in `processTrade()` with actual CLOB order placement

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `TELEGRAM_TOKEN` | — | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | — | Your chat ID |
| `PAPER_MODE` | `true` | Paper or live trading |
| `PAPER_BANKROLL` | `1000` | Starting paper balance |
| `COPY_SIZE` | `25` | $ per copied trade |
| `MIN_TRADE_SIZE` | `50` | Ignore whale trades smaller than this |
| `POLL_INTERVAL_MS` | `15000` | Poll frequency in ms |

## Database

SQLite file: `polymarket_paper.db`

Tables:
- `paper_positions` — every copied trade with entry price, shares, PnL on resolution
- `seen_trades` — dedup log
- `wallet_stats` — per-wallet trade count and total PnL
