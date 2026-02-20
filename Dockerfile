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
COPY scripts/paper-trade-confluence.ts scripts/run-gold-bot.ts ./scripts/

# Copy PM2 ecosystem config
COPY ecosystem.config.cjs ./

# Copy market data (needed for --backtest mode, optional for live)
COPY data/BTCUSDT_1h.json data/ETHUSDT_1h.json data/SOLUSDT_1h.json ./data/

# Ensure writable dirs (gold bot state + PM2 home + logs)
RUN mkdir -p /app/logs /app/.pm2 && \
    addgroup --system app && adduser --system --ingroup app app && \
    chown -R app:app /app/data /app/logs /app/.pm2

USER app

# PM2 needs a writable home dir for pid/config files
ENV PM2_HOME=/app/.pm2

# PM2-runtime keeps the process in foreground (Docker-compatible)
# Runs both crypto-bot and gold-f2f-bot from ecosystem.config.cjs
CMD ["npx", "pm2-runtime", "ecosystem.config.cjs"]
