# rl-trading-agent

A research-to-execution trading system in TypeScript. It has reinforcement-learning agents, a simulator that charges for every fill, overfitting tests that reject most ideas, and a bot that runs whatever survives under hard risk limits.

It started as a way to study ICT (Inner Circle Trader) concepts. It turned into a test of whether any of them hold up once costs are counted.

## What's inside

| Area | What it does | Where |
|---|---|---|
| **RL agents** | DQN, PPO (discrete and continuous), transformer DQN, ensemble and exit agents on TensorFlow.js. Curriculum, multi-symbol and offline training. | `src/lib/rl` |
| **Simulator** | Fill model, intrabar price paths, spread/fee/funding costs, leverage and liquidation. | `src/lib/sim`, `src/lib/cost` |
| **Overfitting defenses** | Deflated Sharpe, probability of backtest overfitting (PBO), Monte Carlo paths, purged cross-validation, CMA-ES optimization. | `src/lib/rl/utils`, `src/lib/meta` |
| **Research agent** | Claude proposes strategies as specs in a small DSL, returned through a tool call. Each spec is re-validated and must clear a cost-aware design screen and the experiment ledger before it runs. | `src/lib/research-agent` |
| **Trading bot** | Multi-sleeve fleet (crypto, gold, metals, leveraged ETFs, funding-rate arbitrage). Paper-forward by default, with a live Bybit path. Telegram alerts. | `src/lib/bot` |
| **ICT library** | Market structure (BOS/CHoCH), order blocks, fair value gaps, breakers, liquidity, kill zones, regime detection. | `src/lib/ict` |
| **Knowledge base** | ICT video transcripts become structured concepts, then embeddings, then semantic search and FSRS flashcards. | `src/lib/kb` |
| **Dashboard** | Next.js admin with per-sleeve returns as a percent of equity, per-trade heat and captured move, and sleeve liveness. | `src/app` |

## What the data said

- **The RL meta-strategy agent failed: 1 of 19 experiments passed.** All 42 features came from the same OHLCV bars that generated the strategies, so the agent had no independent signal. It also had 37K parameters for 26K unique contexts (enough to memorize them) and only got rewarded at trade exit.
- **Costs erased the 1-hour edge.** The strategy made +50% before friction and −103% after a 0.30% round trip. Since then, every idea has to clear costs in the simulator before anything else.
- **Governance came before more strategies.** The RL rework feeds in data the rules can't see: order flow, funding, open interest and liquidations (`src/lib/microstructure`).

## Risk controls

- **Kill switch:** it trips from any of three independent sources (a file, an env var, or a DB row) and stays latched. It only blocks new entries and never force-closes positions; a test asserts that it exposes no close helper.
- **Retirement governor:** pre-committed halt rules that don't trade the equity curve.
  - A single regime trip halves gross exposure.
  - A hard halt needs either an absolute drawdown stop or a conclusive deflated-Sharpe verdict on a long enough track record, plus a corroborating regime cause.
- **Other brakes:**
  - A drawdown-based Sharpe revision.
  - A 3% disaster brake on session legs that have no stop.
  - A disk guard, so logging can't starve the trading fleet.
- **Exchange truth:** stops are placed on the exchange, positions are reconciled at startup, and every decision goes to an append-only log.

Every decision core is a pure function with its inputs injected (clock, drawdown, Sharpe, thresholds), so each branch is unit-tested.

## Stack

TypeScript (strict) · Next.js 16 · tRPC · Drizzle ORM (SQLite locally, PostgreSQL in deployment) · TensorFlow.js · Bybit API · Claude API · Vitest

## Run it

```bash
pnpm install
pnpm db:migrate
pnpm dev            # dashboard at localhost:3000
pnpm test           # vitest
pnpm bot:start      # paper-forward bot, resumes state
pnpm review:weekly  # weekly performance review
```

Optional environment variables in `.env.local`:
- `BYBIT_API_KEY` / `BYBIT_API_SECRET` for live execution
- `ANTHROPIC_API_KEY` for the research agent
- `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` for alerts

Backtests and research scripts are in `scripts/` (`backtest-*.ts`, `run-pbo.ts`, `run-research-live.ts`).

> Research code, not financial advice. Most strategies in this repo were built to be killed.
