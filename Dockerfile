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
COPY scripts/paper-trade-confluence.ts ./scripts/

# Copy market data (needed for --backtest mode, optional for live)
COPY data/BTCUSDT_1h.json data/ETHUSDT_1h.json data/SOLUSDT_1h.json ./data/

# Non-root user for security
RUN addgroup --system app && adduser --system --ingroup app app
USER app

CMD ["npx", "tsx", "scripts/paper-trade-confluence.ts", "--symbols", "BTCUSDT,ETHUSDT,SOLUSDT,LINKUSDT,DOGEUSDT,NEARUSDT,ADAUSDT,APTUSDT,ARBUSDT,MATICUSDT"]
