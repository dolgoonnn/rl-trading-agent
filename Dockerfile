FROM node:20-slim

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Install dependencies
# 1. --ignore-scripts skips native compilation (better-sqlite3, @tensorflow/tfjs-node)
# 2. pnpm rebuild esbuild re-runs only esbuild's postinstall to download its platform binary
#    (esbuild is required by tsx for TypeScript execution)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts && \
    pnpm rebuild esbuild

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/paper-trade-confluence.ts scripts/run-gold-bot.ts scripts/docker-entrypoint.sh ./scripts/

# Copy market data (needed for --backtest mode, optional for live)
COPY data/BTCUSDT_1h.json data/ETHUSDT_1h.json data/SOLUSDT_1h.json ./data/

# Ensure writable dirs (gold bot persists state to data/gold-bot-state.json)
RUN addgroup --system app && adduser --system --ingroup app app && \
    chown -R app:app /app/data && \
    chmod +x /app/scripts/docker-entrypoint.sh

# Set HOME so npx doesn't write to /nonexistent
ENV HOME=/app

USER app

# Shell entrypoint runs both crypto + gold bots as background processes.
# Railway restart policy handles container-level restarts on failure.
CMD ["/app/scripts/docker-entrypoint.sh"]
