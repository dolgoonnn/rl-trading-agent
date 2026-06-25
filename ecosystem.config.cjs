/**
 * PM2 Ecosystem Configuration
 *
 * Independent bots:
 * 1. ict-bot-forward — FORWARD paper run (paper-forward mode). Accumulates a
 *    real-time track record: hourly mark-to-market equity snapshots + persisted
 *    trades for the Sept charter review. PAPER ONLY, no real-money keys.
 * 2. Crypto ICT Bot — 10-symbol, 1H candles, confluence scorer (Run 20 defaults)
 * 3. Gold F2F Bot — XAUTUSDT, daily candles, forecast-to-fill strategy
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs --only ict-bot-forward   # forward paper run
 *   pm2 start ecosystem.config.cjs           # Start all bots
 *   pm2 start ecosystem.config.cjs --only crypto-bot
 *   pm2 start ecosystem.config.cjs --only gold-f2f-bot
 *   pm2 logs                                 # View combined logs
 *   pm2 monit                                # Monitor dashboard
 *   pm2 stop all                             # Stop all
 *
 * Environment variables (set in .env or PM2 env):
 *   TELEGRAM_BOT_TOKEN  — Telegram bot token for alerts
 *   TELEGRAM_CHAT_ID    — Telegram chat ID for alerts
 *
 * PAPER ONLY: never add BYBIT_API_KEY / BYBIT_API_SECRET here — going live is
 * an explicitly-gated separate decision, not a config flip.
 */

module.exports = {
  apps: [
    {
      // Forward paper-trading daemon (Task 3). paper-forward mode disables the
      // backtest-dump path so bot_trades stays an honest forward record.
      name: 'ict-bot-forward',
      script: './node_modules/.bin/tsx',
      args: 'scripts/run-bot.ts --mode paper-forward --symbols BTCUSDT,ETHUSDT,SOLUSDT --resume',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork', // tsx interpreter cannot run under cluster mode
      interpreter: 'none', // exec the tsx bin directly; do not require() it
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      restart_delay: 30000, // 30s delay between restarts
      max_restarts: 10,
      min_uptime: '60s',
      env: {
        NODE_ENV: 'production',
        BOT_MODE: 'paper-forward',
      },
      // Logs
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: 'logs/ict-bot-forward-error.log',
      out_file: 'logs/ict-bot-forward-out.log',
      merge_logs: true,
      // Graceful shutdown
      kill_timeout: 10000,
      listen_timeout: 10000,
    },
    {
      name: 'crypto-bot',
      script: './node_modules/.bin/tsx',
      args: 'scripts/run-bot.ts --symbols BTCUSDT,ETHUSDT,SOLUSDT --resume --verbose',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork', // tsx interpreter cannot run under cluster mode
      interpreter: 'none', // exec the tsx bin directly; do not require() it
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      restart_delay: 30000, // 30s delay between restarts
      max_restarts: 10,
      min_uptime: '60s',
      env: {
        NODE_ENV: 'production',
      },
      // Logs
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: 'logs/crypto-bot-error.log',
      out_file: 'logs/crypto-bot-out.log',
      merge_logs: true,
      // Graceful shutdown
      kill_timeout: 10000,
      listen_timeout: 10000,
    },
    {
      name: 'gold-f2f-bot',
      script: './node_modules/.bin/tsx',
      args: 'scripts/run-gold-bot.ts --verbose --regime-filter zscore50',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork', // tsx interpreter cannot run under cluster mode
      interpreter: 'none', // exec the tsx bin directly; do not require() it
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      restart_delay: 60000, // 60s delay (daily bot, no rush)
      max_restarts: 10,
      min_uptime: '60s',
      env: {
        NODE_ENV: 'production',
      },
      // Logs
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: 'logs/gold-f2f-bot-error.log',
      out_file: 'logs/gold-f2f-bot-out.log',
      merge_logs: true,
      // Graceful shutdown
      kill_timeout: 10000,
      listen_timeout: 10000,
    },
    {
      name: 'session-book-bot',
      script: './node_modules/.bin/tsx',
      args: 'scripts/run-metals-bot.ts --verbose',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork', // tsx interpreter cannot run under cluster mode
      interpreter: 'none', // exec the tsx bin directly; do not require() it
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      restart_delay: 60000,
      max_restarts: 10,
      min_uptime: '60s',
      env: {
        NODE_ENV: 'production',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: 'logs/session-book-bot-error.log',
      out_file: 'logs/session-book-bot-out.log',
      merge_logs: true,
      kill_timeout: 10000,
      listen_timeout: 10000,
    },
    {
      // Book-level governance signal refresh. Reads live sleeve data every 15
      // minutes and rewrites data/book-governance.json (trade / derisk / halt).
      // The crypto bot reads this file fail-open: a dead governor never freezes
      // trading — the bot falls back to `trade` after a 90-min staleness window.
      name: 'book-governor',
      script: './node_modules/.bin/tsx',
      args: 'scripts/run-governor-loop.ts',
      cwd: __dirname,
      exec_mode: 'fork',
      interpreter: 'none',
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      restart_delay: 30000,
      max_restarts: 1000,
      min_uptime: '30s',
      env: {
        NODE_ENV: 'production',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: 'logs/book-governor-error.log',
      out_file: 'logs/book-governor-out.log',
      merge_logs: true,
      kill_timeout: 10000,
      listen_timeout: 10000,
    },
    {
      // L2 order-flow collector (read-only public Bybit WS). Accumulates 1s
      // snapshots (mid, spreadBps, bidDepth5/askDepth5, imb5/25) + publicTrade +
      // allLiquidation to data/orderflow/ — the precondition for the blocked
      // OFI/CVD + liquidation-fade research (needs >=30-60d). Must stay alive;
      // it stalled 2026-06-12, so run it durably. PAPER/read-only, no keys.
      name: 'orderflow-collector',
      script: './node_modules/.bin/tsx',
      args: 'scripts/collect-btc-orderflow.ts',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      interpreter: 'none',
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      restart_delay: 10000, // reconnect quickly — WS drops shouldn't lose much data
      max_restarts: 1000, // long-lived collector: many reconnects expected over weeks
      min_uptime: '30s',
      env: {
        NODE_ENV: 'production',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: 'logs/orderflow-collector-error.log',
      out_file: 'logs/orderflow-collector-out.log',
      merge_logs: true,
      kill_timeout: 10000,
      listen_timeout: 10000,
    },
  ],
};
