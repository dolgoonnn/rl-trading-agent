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

# Forward signals to children
cleanup() {
  echo "Received shutdown signal, stopping bots..."
  kill "$CRYPTO_PID" "$GOLD_PID" 2>/dev/null || true
  wait "$CRYPTO_PID" "$GOLD_PID" 2>/dev/null || true
  echo "Bots stopped."
  exit 0
}
trap cleanup SIGTERM SIGINT

# Wait for any child to exit — if either crashes, we restart both
wait -n 2>/dev/null || true
EXIT_CODE=$?
echo "A bot process exited with code $EXIT_CODE, shutting down..."
kill "$CRYPTO_PID" "$GOLD_PID" 2>/dev/null || true
wait 2>/dev/null || true
exit "$EXIT_CODE"
