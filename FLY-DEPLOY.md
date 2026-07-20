# Fly.io deployment — ICT paper fleet

Runs the 5-process paper fleet (`scripts/docker-entrypoint.sh`) as a single
always-on Fly machine, using the validated `Dockerfile`. State persists to a Fly
volume at `/app/data`. No web server — it's a background worker.

## One-time setup

```bash
# 1. Install flyctl + log in (or sign up)
brew install flyctl          # macOS; else: curl -L https://fly.io/install.sh | sh
fly auth login

# 2. Create the app (pick a globally-unique name; then set it in fly.toml `app = `)
fly apps create ict-paper-fleet-<you>

# 3. Create the persistent volume — region MUST match fly.toml primary_region.
#    1 GB is plenty (SQLite db + JSON state + orderflow ndjson).
fly volumes create ict_data --size 1 --region sin --app ict-paper-fleet-<you>

# 4. (optional) Telegram alerts
fly secrets set TELEGRAM_BOT_TOKEN=xxx TELEGRAM_CHAT_ID=yyy --app ict-paper-fleet-<you>

# 5. Deploy
fly deploy --app ict-paper-fleet-<you>
```

## Verify

```bash
fly logs --app ict-paper-fleet-<you>
```
Expect: `=== Starting ICT paper fleet (5 processes) ===`, then each bot starting,
then `Backfilling candle history... BTCUSDT: 2499 candles cached` and
`Bot started successfully`. Check the DB later:
```bash
fly ssh console -C "sqlite3 /app/data/ict-trading.db 'SELECT COUNT(*) FROM bot_candles;'"
```

## Critical gotchas

- **Exactly ONE machine.** Do NOT `fly scale count 2` — each machine gets its own
  volume, which would fork the track record and race the shared JSON state files.
  Keep `min_machines_running = 1`, no autoscaling.
- **Volume region == app region.** The volume and the machine must be in the same
  region or the mount fails.
- **No secrets required** to trade (paper mode, public endpoints). Only Telegram
  is optional. NEVER set `BYBIT_API_KEY`/`BYBIT_API_SECRET` — going live is a
  separate, explicit decision.
- **Cost:** shared-cpu-1x @ 1 GB + a 1 GB volume runs within Fly's small usage
  allowance / a few $/mo. Drop `memory` to `512mb` in fly.toml to trim it.

## Empty vs migrated state

An empty volume self-initializes (migrate-on-startup + fresh state files) — a
clean forward record, which is the better choice given the local record is mostly
downtime-contaminated. To carry over local state instead, `fly ssh sftp shell`
and upload `data/ict-trading.db` + `gold-bot-state.json` + `metals-bot-state.json`
into `/app/data` before the first real trade.
