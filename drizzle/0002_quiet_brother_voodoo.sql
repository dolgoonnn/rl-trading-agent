CREATE TABLE `bot_candles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol` text NOT NULL,
	`timestamp` integer NOT NULL,
	`open` real NOT NULL,
	`high` real NOT NULL,
	`low` real NOT NULL,
	`close` real NOT NULL,
	`volume` real NOT NULL
);
--> statement-breakpoint
CREATE TABLE `bot_equity_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`timestamp` integer NOT NULL,
	`equity` real NOT NULL,
	`peak_equity` real NOT NULL,
	`drawdown` real NOT NULL,
	`open_positions` integer NOT NULL,
	`daily_pnl` real NOT NULL,
	`cumulative_pnl` real NOT NULL
);
--> statement-breakpoint
CREATE TABLE `bot_positions` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`direction` text NOT NULL,
	`status` text NOT NULL,
	`entry_price` real NOT NULL,
	`entry_timestamp` integer NOT NULL,
	`entry_bar_index` integer NOT NULL,
	`stop_loss` real NOT NULL,
	`take_profit` real NOT NULL,
	`current_sl` real NOT NULL,
	`position_size_usdt` real NOT NULL,
	`risk_amount_usdt` real NOT NULL,
	`strategy` text NOT NULL,
	`confluence_score` real NOT NULL,
	`factor_breakdown` text NOT NULL,
	`regime` text NOT NULL,
	`partial_taken` integer DEFAULT false NOT NULL,
	`partial_pnl_percent` real DEFAULT 0 NOT NULL,
	`exit_price` real,
	`exit_timestamp` integer,
	`exit_reason` text,
	`bars_held` integer,
	`pnl_percent` real,
	`pnl_usdt` real,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `bot_state` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`equity` real NOT NULL,
	`peak_equity` real NOT NULL,
	`consecutive_losses` integer DEFAULT 0 NOT NULL,
	`daily_pnl` real DEFAULT 0 NOT NULL,
	`weekly_pnl` real DEFAULT 0 NOT NULL,
	`circuit_breakers` text DEFAULT '[]' NOT NULL,
	`last_processed_timestamp` text DEFAULT '{}' NOT NULL,
	`recent_errors` text DEFAULT '[]' NOT NULL,
	`total_trades` integer DEFAULT 0 NOT NULL,
	`started_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `bot_trades` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`direction` text NOT NULL,
	`entry_price` real NOT NULL,
	`exit_price` real NOT NULL,
	`entry_timestamp` integer NOT NULL,
	`exit_timestamp` integer NOT NULL,
	`stop_loss` real NOT NULL,
	`take_profit` real NOT NULL,
	`position_size_usdt` real NOT NULL,
	`risk_amount_usdt` real NOT NULL,
	`strategy` text NOT NULL,
	`confluence_score` real NOT NULL,
	`factor_breakdown` text NOT NULL,
	`regime` text NOT NULL,
	`exit_reason` text NOT NULL,
	`bars_held` integer NOT NULL,
	`pnl_percent` real NOT NULL,
	`pnl_usdt` real NOT NULL,
	`equity_after` real NOT NULL,
	`drawdown_from_peak` real NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `funding_arb_positions` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`direction` text NOT NULL,
	`status` text NOT NULL,
	`entry_price` real NOT NULL,
	`entry_spread` real NOT NULL,
	`entry_funding_rate` real NOT NULL,
	`entry_timestamp` integer NOT NULL,
	`position_size_usdt` real NOT NULL,
	`funding_payments` text DEFAULT '[]' NOT NULL,
	`total_funding_collected` real DEFAULT 0 NOT NULL,
	`funding_payment_count` integer DEFAULT 0 NOT NULL,
	`exit_price` real,
	`exit_timestamp` integer,
	`exit_reason` text,
	`exit_spread` real,
	`spread_cost` real DEFAULT 0 NOT NULL,
	`net_pnl_usdt` real DEFAULT 0 NOT NULL,
	`hold_time_hours` real DEFAULT 0 NOT NULL,
	`annualized_apy` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `funding_rate_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol` text NOT NULL,
	`funding_rate` real NOT NULL,
	`next_funding_time` integer NOT NULL,
	`mark_price` real NOT NULL,
	`index_price` real NOT NULL,
	`bid1` real NOT NULL,
	`ask1` real NOT NULL,
	`spread` real NOT NULL,
	`polled_at` integer NOT NULL
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_paper_trades` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trade_id` text NOT NULL,
	`session_id` text NOT NULL,
	`symbol` text NOT NULL,
	`timeframe` text NOT NULL,
	`side` text NOT NULL,
	`status` text NOT NULL,
	`entry_price` real NOT NULL,
	`exit_price` real,
	`stop_loss` real NOT NULL,
	`take_profit` real NOT NULL,
	`entry_time` integer NOT NULL,
	`exit_time` integer,
	`entry_index` integer NOT NULL,
	`exit_index` integer,
	`bars_held` integer,
	`entry_confluence` real,
	`entry_factors` text,
	`exit_action` text,
	`exit_reason` text,
	`pnl` real,
	`pnl_percent` real,
	`kb_primary_concept` text,
	`kb_alignment_score` real,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_paper_trades`("id", "trade_id", "session_id", "symbol", "timeframe", "side", "status", "entry_price", "exit_price", "stop_loss", "take_profit", "entry_time", "exit_time", "entry_index", "exit_index", "bars_held", "entry_confluence", "entry_factors", "exit_action", "exit_reason", "pnl", "pnl_percent", "kb_primary_concept", "kb_alignment_score", "created_at") SELECT "id", "trade_id", "session_id", "symbol", "timeframe", "side", "status", "entry_price", "exit_price", "stop_loss", "take_profit", "entry_time", "exit_time", "entry_index", "exit_index", "bars_held", "entry_confluence", "entry_factors", "exit_action", "exit_reason", "pnl", "pnl_percent", "kb_primary_concept", "kb_alignment_score", "created_at" FROM `paper_trades`;--> statement-breakpoint
DROP TABLE `paper_trades`;--> statement-breakpoint
ALTER TABLE `__new_paper_trades` RENAME TO `paper_trades`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `paper_trades_trade_id_unique` ON `paper_trades` (`trade_id`);