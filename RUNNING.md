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

## Exchange-native protective exits (--exchange-exits)

When this flag is set, the bot places the stop-loss and final take-profit as a **position-attached reduce-only stop on Bybit** (`setTradingStop`, V5, one-way mode) the instant a live limit entry fills. The stop lives on the exchange, so a hard process crash (`kill -9`, OOM, machine reboot) can never leave a position unprotected — the venue still fires the stop.

**Requirements**
- `BYBIT_API_KEY` and `BYBIT_API_SECRET` env vars (real mainnet keys, or testnet keys with testnet endpoint)
- Pass `--exchange-exits` on the CLI
- Default: **OFF** — paper mode, backtests, and the Run-20 validation are completely unaffected

**Behavior**

| Event | What happens |
|-------|-------------|
| Limit entry fills | `armExits` → SL + final TP armed on Bybit. If arming fails, position is **immediately flattened** (market reduce-only); the unprotected position is NOT tracked |
| In-process partial-TP hit | Breakeven SL move is **re-armed** on Bybit via a second `armExits` call |
| Time-exit (max_bars) or graceful shutdown | Real Bybit position **flattened** (market reduce-only) + exchange stop cleared |
| Hard crash (`kill -9`) | Process dies; exchange stop **stays armed** and protects the open position |

**Phase 1 caveat — partial-TP stays in-process**
Only the hard SL and the final TP live on the exchange. The fractional partial-TP (e.g. 50 % @ 1.41 R) continues to be managed in-process, exactly as validated in Run-20. Phase 2 — moving the fractional partial onto the exchange as a resting reduce-only order — is deferred; it requires fill-reconciliation (poll closed-PnL) and introduces an accepted parity change (exchange fills intrabar vs. our candle-close model).

**Phase 2a (DONE) — per-tick close reconciliation**
Each tick, if the venue has flattened a position the shadow still holds open (its SL/TP fired on Bybit), the bot detects it (`getOpenSize` → flat) and closes the shadow at the **real exchange exit price** (`getClosedPnL.avgExitPrice`), skipping the in-process check for that tick. So the bot no longer "manages" a position that is already closed on the exchange, and an exchange-driven close books at the true venue price.

**Phase 2b (DONE) — partial propagated to the venue**
When the in-process partial-TP fires, the bot reduces the REAL Bybit position by the same fraction with a **market reduce-only** order at the same candle-close moment, then re-arms SL(BE)+TP for the remainder. So the venue realizes the partial too — a reversal-to-BE now sells only the remainder at BE (the partial was already realized at ~the partial price), matching the shadow's blended PnL. Chosen over a resting reduce-only limit at the partial price specifically to AVOID an intrabar-vs-candle-close parity change — the trigger stays candle-close, so Run-20 needs no re-measurement and the backtest path is untouched.

> ℹ️ **Residual (bounded).** The venue partial fills at a market price ≈ candle-close ± slippage; the shadow books at candle-close × friction. The structural size mismatch is gone; only a bounded slippage-sized price difference on the partial leg remains (same order as modelled friction). Step-rounding on `size × fraction` can leave tiny dust on the remainder. Still sensible to spot-check realized PnL against the Bybit balance when first live.

**Pre-live verification checklist (manual — operator must complete before trusting with real money)**

This procedure has **NOT yet been run**. The flag is not considered validated for real-money use until all steps below are confirmed with evidence (screenshot or `getPositionInfo` output).

```bash
# 1. Start with testnet keys and limit-orders mode
BYBIT_API_KEY=<testnet_key> BYBIT_API_SECRET=<testnet_secret> \
  npx tsx scripts/run-bot.ts --limit-orders --exchange-exits

# 2. After a fill: confirm SL + TP appear on the Bybit testnet position
#    (check the testnet UI, or poll getPositionInfo — look for stopLoss / takeProfit fields)

# 3. Kill the process hard and confirm the stop survives
kill -9 <pid>
#    Check testnet UI / API — SL+TP must STILL be present

# 4. Restart; let an exit occur; confirm the stop is cleared
#    No orphan reduce-only stop should remain on the position after close
```

Expected: SL+TP visible post-fill ✓ · survive kill -9 ✓ · cleared after close ✓. Record pass/fail with screenshots or API output before enabling on mainnet.

## DO NOT do this while it's accumulating
- **Do not run `npx tsx scripts/replay-bot.ts`** against this DB — a non-`--fresh` run still APPENDS backtest trades into the live forward `bot_trades` (known hole, audit-flagged). Use a separate DB or wait until that's fixed.
- Don't go live (real keys) — entry-side execution safety (mark collar margin, L2) is paper-validated only.

## Known-good baseline
Full test suite 320/320 green; typecheck 227 errors (all pre-existing/unrelated). Safety stack verified live by adversarial audit: latched kill-switch + drawdown halt (29.9%) + sustained-DSR halt + pre-trade guards all fire on the live tick. See `PROGRESS.md` for the full audit + fix history.

## Book governance

The `book-governor` PM2 app (`scripts/run-governor-loop.ts`) refreshes
`data/book-governance.json` every 15 minutes. The crypto bot reads this file
before each hourly tick and adjusts its behavior accordingly.

### Signal values

| `action` | Meaning | Effect on crypto bot |
|----------|---------|----------------------|
| `trade` | Book is healthy | Normal operation (multiplier = 1.0) |
| `derisk` | 60d book Sharpe < threshold | Notional scaled down (multiplier < 1; review before kill) |
| `halt` | Book absolute drawdown >= hard kill | All new entries blocked (multiplier = 0; manual review required) |

### Fail-open guarantee

A dead or crashed governor **never freezes the book**. The crypto bot checks
the `asOfMs` field: if the signal file is missing or older than 90 minutes it
falls back to `action: trade` with a console warning and continues normally.
The 15-minute refresh cadence gives 6× headroom before the staleness window is
reached.

### Inspect the current signal

```bash
cat data/book-governance.json
# Look for: "action", "reason", "asOfMs" (epoch ms — check it is recent)
```

### Start / check the governor

```bash
pm2 start ecosystem.config.cjs --only book-governor
pm2 logs book-governor    # live tail
pm2 list                  # confirm status is "online"
pm2 save                  # persist after adding the new app
```

---

### One-time operator migration: clear the stale per-sleeve latch (OPERATOR ACTION — do NOT run autonomously)

After deploying book governance, the crypto bot may still be latched
`source:'retirement'` from the OLD per-sleeve sustained-DSR halt. This latch
predates the book-level governor. Once the governor is live and healthy, clear
it so crypto resumes under book authority.

**SAFETY: complete these steps in order. Do not skip step 1.**

**Step 1 — inspect the current latch and the book signal**

```bash
# Confirm what the latch says
sqlite3 data/ict-trading.db "SELECT * FROM bot_kill_switch;"

# Confirm the book signal exists and is healthy (action must be 'trade' or 'derisk', NOT 'halt')
cat data/book-governance.json
```

**Step 2 — clear the latch ONLY IF:**
- The latch `source` is the old per-sleeve retirement halt (e.g. `source='retirement'`), AND
- `data/book-governance.json` shows `"action": "trade"` or `"action": "derisk"` (the book itself is NOT breaching).

If the book shows `"action": "halt"`, leave crypto halted — the book governor agrees with the stop. Do not clear.

```bash
# Clear the stale latch (run this command yourself after confirming step 1 above)
sqlite3 data/ict-trading.db "UPDATE bot_kill_switch SET halted=0, source='', reason='cleared: migrated to book governance 2026-06-25' WHERE id=1;"

# Verify
sqlite3 data/ict-trading.db "SELECT * FROM bot_kill_switch;"
```

The crypto bot picks up the cleared latch on its next hourly tick — no restart required.
