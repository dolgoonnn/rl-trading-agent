FROM node:20-slim

# Build toolchain for better-sqlite3's native module (the whole fleet — crypto,
# gold, metals — persists to SQLite via better-sqlite3). ca-certificates so the
# bots' HTTPS calls to Bybit/Yahoo resolve.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# pnpm via corepack — pin to the version that generated the lockfile (pnpm@latest
# is now 11.x which needs Node 22+; this image is Node 20).
RUN corepack enable && corepack prepare pnpm@10.34.1 --activate

WORKDIR /app

# Install deps. --ignore-scripts skips ALL native postinstalls (incl. the heavy
# @tensorflow/tfjs-node, which the live fleet does not use); then rebuild only
# the two the fleet DOES need: esbuild (tsx's TS runtime) and better-sqlite3.
COPY package.json pnpm-lock.yaml ./
# --ignore-scripts skips ALL native postinstalls (incl. the heavy, unused
# @tensorflow/tfjs-node). Then build the two the live fleet needs: esbuild
# (tsx's runtime) via pnpm rebuild, and better-sqlite3's native addon by running
# its OWN build-release script directly (pnpm 10 gates build scripts behind an
# allowlist, so `pnpm rebuild better-sqlite3` is a silent no-op → the runtime
# "Could not locate the bindings file" crash). Compiling in-place bypasses that.
RUN pnpm install --frozen-lockfile --ignore-scripts && \
    pnpm rebuild esbuild && \
    cd "$(node -p "require('path').dirname(require.resolve('better-sqlite3/package.json'))")" && \
    npm run build-release

# App source + migrations. The whole scripts/ dir is copied so no entry script
# is missing a sibling import; drizzle/ holds the migrations run on startup.
COPY tsconfig.json drizzle.config.ts ./
COPY src/ ./src/
COPY drizzle/ ./drizzle/
COPY scripts/ ./scripts/

RUN chmod +x /app/scripts/docker-entrypoint.sh

# Runs as root: Railway mounts the /app/data volume root-owned, and running as
# root sidesteps volume-permission friction for a paper bot. HOME set so npx/pnpm
# don't write to /nonexistent.
ENV HOME=/app NODE_ENV=production

# NOTE: attach a Railway VOLUME mounted at /app/data or all state is lost on
# restart. An empty volume self-initializes (run-bot.ts migrates on startup).
CMD ["/app/scripts/docker-entrypoint.sh"]
