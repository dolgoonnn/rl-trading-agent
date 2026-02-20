/**
 * PM2 Ecosystem Configuration
 *
 * Two independent bots:
 * 1. Crypto ICT Bot — BTC/ETH/SOL, 1H candles, order_block strategy (Run 18)
 * 2. Gold F2F Bot — XAUTUSDT, daily candles, forecast-to-fill strategy
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs           # Start both bots
 *   pm2 start ecosystem.config.cjs --only crypto-bot
 *   pm2 start ecosystem.config.cjs --only gold-f2f-bot
 *   pm2 logs                                 # View combined logs
 *   pm2 monit                                # Monitor dashboard
 *   pm2 stop all                             # Stop all
 *
 * Environment variables (set in .env or PM2 env):
 *   TELEGRAM_BOT_TOKEN  — Telegram bot token for alerts
 *   TELEGRAM_CHAT_ID    — Telegram chat ID for alerts
 */

module.exports = {
  apps: [
    {
      name: 'crypto-bot',
      script: 'npx',
      args: 'tsx scripts/run-bot.ts --verbose',
      cwd: __dirname,
      instances: 1,
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
      script: 'npx',
      args: 'tsx scripts/run-gold-bot.ts --verbose --regime-filter zscore50',
      cwd: __dirname,
      instances: 1,
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
  ],
};
