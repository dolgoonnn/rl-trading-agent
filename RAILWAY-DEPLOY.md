# Railway deployment — paper fleet (5 processes)

The `Dockerfile` + `scripts/docker-entrypoint.sh` run the **current** 5-process
paper fleet in one container:

1. `run-bot.ts` — crypto forward bot (Run 20, BTC/ETH/SOL, paper-forward)
2. `run-gold-bot.ts` — gold F2F daily bot (XAUTUSDT, zscore50)
3. `run-metals-bot.ts` — session/metals book
4. `run-governor-loop.ts` — book-level governance signal (every 15m)
5. `collect-btc-orderflow.ts` — L2 order-flow collector (non-fatal)
6. `next start` — read-only web dashboard (non-fatal, see "Web dashboard" below)

The 5-bot fleet was validated locally with `docker build` + `docker run` (all
5 core bots start, better-sqlite3 compiles, migrations run on a fresh volume,
crypto backfills from Bybit, state persists to the mounted volume). The added
`next build`/`next start` dashboard step was validated with `docker build`
only (a full `docker run` would start live-trading bot processes, so it's
left to the actual Railway deploy) — confirm `next start` prints `Ready on
http://...` in the first Railway deploy log.

## Deploy steps (needs your Railway account)

1. **Create the service** from this repo (Railway auto-detects the Dockerfile via
   `railway.toml`, builder = dockerfile).

2. **Set the region to Southeast Asia (Singapore) — THE critical step.** Service →
   Settings → Deploy → Regions → `asia-southeast1`. Railway defaults new services
   to a **US region**, but Bybit geo-blocks the US at the CloudFront layer: every
   REST call returns `403 Forbidden — "The Amazon CloudFront distribution is
   configured to block access from your country"`, a core bot throws a fatal error,
   the entrypoint exits, and Railway crash-loops the container. (The public
   WebSocket connects fine from the US, which is misleading — REST is what's
   blocked, and both crypto backfill and the gold bot need it.) Region is NOT
   settable via `railway.toml` or the CLI — it's a dashboard-only setting. If
   Singapore isn't offered on your plan, pick EU West (Amsterdam); never a US region.

3. **Attach a persistent volume** — THE critical step. Mount path **`/app/data`**.
   Without it, every restart wipes all trades/equity/positions (the container FS
   is ephemeral). An empty volume self-initializes: `run-bot.ts` migrates the DB
   on startup, and the gold/metals bots create their JSON state files.

4. **(Optional) Telegram alerts** — set env vars `TELEGRAM_BOT_TOKEN` and
   `TELEGRAM_CHAT_ID` to get halt/trade pings.

5. **Do NOT set exchange keys** — this is paper-only. Going live is a separate,
   explicit decision (never add `BYBIT_API_KEY`/`BYBIT_API_SECRET` here).

6. **Restart policy** — `railway.toml` sets `ON_FAILURE`, max 5 retries. If a CORE
   trading process dies, the entrypoint exits non-zero → Railway restarts the
   container clean and the bots resume from the volume.

## Web dashboard

The container also serves a read-only Next.js dashboard on `$PORT` as a
**non-core** 6th process — if it dies, trading continues uninterrupted (only
the crypto/gold/metals/governor core dying restarts the container).

- In Railway, enable **public networking**: Service → Settings → Networking →
  Generate Domain.
- Ensure the service has **≥2 GB RAM** — five bot processes plus a Next.js
  server need more headroom than the bots alone.
- Once deployed, the book is reachable at `https://<domain>/live-trading`.
- View-only, no auth — acceptable because this is a paper-only fleet with no
  control procedures exposed (all tRPC procedures are `query`, never
  `mutation`).

## Why Railway over the laptop

The laptop host caused the degraded track record: intermittent system sleep
(strands open positions) and severe DNS instability (`getaddrinfo ENOTFOUND
api.bybit.com` — 5,888 failures over 12 days, peaking 600+/day, making the bot
skip past signal bars). A stable always-on host with reliable DNS fixes all of
it. This is the #1 lever for a trustworthy September track record.

## Migrating existing state (optional)

To carry over the current local track record instead of starting fresh, copy the
local `data/ict-trading.db`, `data/gold-bot-state.json`, and
`data/metals-bot-state.json` into the Railway volume once (via `railway run` or a
one-off shell). Otherwise the cloud fleet starts a clean forward record — which,
given the local record is mostly downtime-contaminated, is arguably cleaner.

## First-run sanity check

After deploy, the container logs should show all five starting, then
`Backfilling candle history... BTCUSDT: 2499 candles cached` and
`Bot started successfully`. `railway run` a check:
`sqlite3 /app/data/ict-trading.db "SELECT COUNT(*) FROM bot_candles;"`
