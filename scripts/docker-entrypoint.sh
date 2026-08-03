#!/bin/sh
# Docker/Railway entrypoint — runs the CURRENT 5-process paper fleet as
# background jobs under a simple supervisor. If any CORE trading process dies,
# we kill the rest and exit non-zero so Railway's restart policy relaunches the
# whole container clean (bots resume from the persistent /app/data volume:
# ict-trading.db + gold/metals JSON state). Mirrors ecosystem.config.cjs.
#
# PERSISTENCE: /app/data MUST be a mounted Railway volume, or all state (trades,
# equity, positions) is lost on every restart. run-bot.ts migrates-on-startup,
# so an EMPTY volume self-initializes (fresh DB + migrations, fresh state files).
#
# PAPER ONLY: no exchange keys. Going live is a separate, explicit decision.

set -e

echo "=== Starting ICT paper fleet (5 processes) ==="
mkdir -p /app/data /app/logs

# 1. Crypto forward bot (Run 20, BTC/ETH/SOL, paper-forward, resumes state)
npx tsx scripts/run-bot.ts --mode paper-forward --symbols BTCUSDT,ETHUSDT,SOLUSDT --resume &
CRYPTO_PID=$!

# 2. Gold F2F daily bot (XAUTUSDT, zscore50 regime filter)
npx tsx scripts/run-gold-bot.ts --verbose --regime-filter zscore50 &
GOLD_PID=$!

# 3. Session/metals book bot
npx tsx scripts/run-metals-bot.ts --verbose &
METALS_PID=$!

# 4. Book-governor (writes data/book-governance.json every 15m; bots fail-open)
npx tsx scripts/run-governor-loop.ts &
GOV_PID=$!

# 5. L2 order-flow collector (read-only public WS; non-fatal research feed)
npx tsx scripts/collect-btc-orderflow.ts &
FLOW_PID=$!

# 6. Read-only web dashboard (non-core: if it dies, trading continues).
npx next start -p "${PORT:-3000}" &
UI_PID=$!

# 7. LETF close-flow paper bot (EXPERIMENTAL sleeve, non-fatal: separate state,
#    separate attribution, regime kill-switch — experiments/letf-close-flow.md)
npx tsx scripts/run-letf-bot.ts --verbose &
LETF_PID=$!

echo "  crypto=$CRYPTO_PID gold=$GOLD_PID metals=$METALS_PID governor=$GOV_PID orderflow=$FLOW_PID ui=$UI_PID letf=$LETF_PID"

# Core processes whose death should restart the whole container.
CORE_PIDS="$CRYPTO_PID $GOLD_PID $METALS_PID $GOV_PID"

cleanup() {
  echo "Received shutdown signal, stopping fleet..."
  kill "$CRYPTO_PID" "$GOLD_PID" "$METALS_PID" "$GOV_PID" "$FLOW_PID" "$UI_PID" "$LETF_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  echo "Fleet stopped."
  exit 0
}
trap cleanup TERM INT

# Supervise: exit (→ container restart) if any CORE process dies. The orderflow
# collector and web dashboard are non-fatal — if either dies we log but keep
# trading.
FLOW_WARNED=0
UI_WARNED=0
LETF_WARNED=0
while true; do
  for pid in $CORE_PIDS; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "CORE process $pid exited — restarting container to recover clean fleet."
      kill "$CRYPTO_PID" "$GOLD_PID" "$METALS_PID" "$GOV_PID" "$FLOW_PID" "$UI_PID" "$LETF_PID" 2>/dev/null || true
      wait 2>/dev/null || true
      exit 1
    fi
  done
  if [ "$FLOW_WARNED" -eq 0 ] && ! kill -0 "$FLOW_PID" 2>/dev/null; then
    echo "WARN: orderflow collector ($FLOW_PID) exited (non-fatal); trading continues."
    FLOW_WARNED=1
  fi
  if [ "$UI_WARNED" -eq 0 ] && ! kill -0 "$UI_PID" 2>/dev/null; then
    echo "WARN: web dashboard ($UI_PID) exited (non-fatal); trading continues."
    UI_WARNED=1
  fi
  if [ "$LETF_WARNED" -eq 0 ] && ! kill -0 "$LETF_PID" 2>/dev/null; then
    echo "WARN: LETF close-flow bot ($LETF_PID) exited (non-fatal, experimental); trading continues."
    LETF_WARNED=1
  fi
  sleep 15
done
