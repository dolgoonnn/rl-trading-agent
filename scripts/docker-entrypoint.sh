#!/bin/sh
# Docker entrypoint: runs both crypto and gold bots as background processes.
# If either exits, the other is killed and the container restarts via Railway.

set -e

echo "=== Starting ICT Trading Bots ==="
echo "  Crypto: 10-symbol, Run 18 defaults"
echo "  Gold F2F: XAUTUSDT, zscore50 filter, lambda=0.95, theta=0.91"
echo ""

# Start crypto bot
npx tsx scripts/paper-trade-confluence.ts \
  --symbols BTCUSDT,ETHUSDT,SOLUSDT,LINKUSDT,DOGEUSDT,NEARUSDT,ADAUSDT,APTUSDT,ARBUSDT,MATICUSDT &
CRYPTO_PID=$!

# Start gold F2F bot
npx tsx scripts/run-gold-bot.ts --verbose --regime-filter zscore50 &
GOLD_PID=$!

echo "  Crypto PID: $CRYPTO_PID"
echo "  Gold PID: $GOLD_PID"

# Forward signals to children (use TERM/INT for dash compatibility)
cleanup() {
  echo "Received shutdown signal, stopping bots..."
  kill "$CRYPTO_PID" "$GOLD_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  echo "Bots stopped."
  exit 0
}
trap cleanup TERM INT

# Monitor both processes — if either exits, restart both
while true; do
  # Check if either process has died
  if ! kill -0 "$CRYPTO_PID" 2>/dev/null; then
    echo "Crypto bot (PID $CRYPTO_PID) exited, shutting down..."
    kill "$GOLD_PID" 2>/dev/null || true
    wait 2>/dev/null || true
    exit 1
  fi
  if ! kill -0 "$GOLD_PID" 2>/dev/null; then
    echo "Gold bot (PID $GOLD_PID) exited, shutting down..."
    kill "$CRYPTO_PID" 2>/dev/null || true
    wait 2>/dev/null || true
    exit 1
  fi
  sleep 30
done
