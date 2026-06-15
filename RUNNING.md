# Running the forward paper bots (PM2)

**Status as of 2026-06-15:** PAPER-ONLY forward run, accumulating a track record toward the **2026-09-11 charter review**. No real-money keys anywhere. Branch: `ftr/overnight-bot-hardening`.

## What's running (under PM2, autorestart on crash)
| App | What | Cadence | Writes |
|-----|------|---------|--------|
| `ict-bot-forward` | Crypto Run-20 (BTC/ETH/SOL), paper-forward mode | hourly | `bot_trades` / `bot_equity_snapshots` in `data/ict-trading.db` |
| `gold-f2f-bot` | Gold F2F (XAUTUSDT), paper | daily (~00:05 UTC) | same DB, tagged `f2f_gold` |
| `orderflow-collector` | Bybit L2 + trades + liquidations, BTCUSDT | 1s snapshots | `data/orderflow/BTCUSDT_<day>.ndjson` |

## Check on it
```bash
pm2 list                      # status + restart counts (↺ climbing = something's wrong)
pm2 logs ict-bot-forward      # live crypto bot log
pm2 logs gold-f2f-bot         # live gold bot log
pm2 monit                     # dashboard
# data sanity:
sqlite3 data/ict-trading.db "SELECT COUNT(*) FROM bot_equity_snapshots; SELECT COUNT(*) FROM bot_trades;"
wc -l data/orderflow/BTCUSDT_$(date -u +%F).ndjson   # order-flow accumulating
```

## Stop it
```bash
touch data/KILL               # EMERGENCY: reduce-only halt (blocks new entries, keeps managing open) — both bots respect it
pm2 stop all                  # stop the processes
pm2 delete all                # remove from PM2
rm data/KILL                  # clear the kill flag when resuming
```

## ⚠️ One manual step for crash/reboot survival (needs sudo — run it yourself once)
`pm2 save` already persisted the process list, but to make PM2 relaunch on **machine reboot**:
```bash
pm2 startup        # prints a `sudo env PATH=... pm2 startup ...` command — paste & run THAT, then:
pm2 save
```
Without this, a reboot stops everything (the processes survive crashes via autorestart, but not a full reboot until `pm2 startup` is configured).

## Optional: enable Telegram halt/death alerts
Currently OFF (no `.env`). To get pinged when a bot halts or trips a guard, create `.env`:
```
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```
then `pm2 restart all --update-env`. (Alerts no-op silently without it — nothing breaks.)

## DO NOT do this while it's accumulating
- **Do not run `npx tsx scripts/replay-bot.ts`** against this DB — a non-`--fresh` run still APPENDS backtest trades into the live forward `bot_trades` (known hole, audit-flagged). Use a separate DB or wait until that's fixed.
- Don't go live (real keys) — entry-side execution safety (mark collar margin, L2) is paper-validated only.

## Known-good baseline
Full test suite 320/320 green; typecheck 227 errors (all pre-existing/unrelated). Safety stack verified live by adversarial audit: latched kill-switch + drawdown halt (29.9%) + sustained-DSR halt + pre-trade guards all fire on the live tick. See `PROGRESS.md` for the full audit + fix history.
