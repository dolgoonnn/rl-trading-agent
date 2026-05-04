/**
 * PM2 Ecosystem Configuration
 *
 * Four PM2 entries:
 * 1. Crypto ICT Bot — 10-symbol, 1H candles, confluence scorer (Run 20 defaults), always running
 * 2. Gold F2F Bot — XAUTUSDT, daily candles, forecast-to-fill strategy, always running
 * 3. Allocator Cron — Portfolio rebalancing, Sundays 00:05 UTC
 * 4. Monitor Cron — Status reports, daily 00:10 UTC
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs           # Start all 4 entries
 *   pm2 start ecosystem.config.cjs --only crypto-bot
 *   pm2 start ecosystem.config.cjs --only gold-f2f-bot
 *   pm2 start ecosystem.config.cjs --only allocator-cron
 *   pm2 start ecosystem.config.cjs --only monitor-cron
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
      script: './node_modules/.bin/tsx',
      args: 'scripts/run-bot.ts --symbols BTCUSDT,ETHUSDT,SOLUSDT --resume --verbose',
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
      script: './node_modules/.bin/tsx',
      args: 'scripts/run-gold-bot.ts --verbose --regime-filter zscore50',
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
    {
      name: 'allocator-cron',
      script: './node_modules/.bin/tsx',
      args: 'scripts/run-allocator.ts',
      cwd: __dirname,
      instances: 1,
      autorestart: false,
      cron_restart: '5 0 * * 0', // Sundays 00:05 UTC
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: 'logs/allocator-cron-error.log',
      out_file: 'logs/allocator-cron-out.log',
      merge_logs: true,
    },
    {
      name: 'monitor-cron',
      script: './node_modules/.bin/tsx',
      args: 'scripts/run-monitor.ts',
      cwd: __dirname,
      instances: 1,
      autorestart: false,
      cron_restart: '10 0 * * *', // daily 00:10 UTC
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: 'logs/monitor-cron-error.log',
      out_file: 'logs/monitor-cron-out.log',
      merge_logs: true,
    },
  ],
};
