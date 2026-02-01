CREATE TABLE `paper_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`timeframe` text NOT NULL,
	`model_path` text NOT NULL,
	`config` text NOT NULL,
	`total_trades` integer DEFAULT 0,
	`wins` integer DEFAULT 0,
	`losses` integer DEFAULT 0,
	`total_pnl` real DEFAULT 0,
	`total_pnl_percent` real DEFAULT 0,
	`max_drawdown` real DEFAULT 0,
	`sharpe` real DEFAULT 0,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`uptime_seconds` integer DEFAULT 0,
	`is_active` integer DEFAULT true
);
--> statement-breakpoint
CREATE TABLE `paper_trades` (
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
	`entry_confluence` integer,
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
CREATE UNIQUE INDEX `paper_trades_trade_id_unique` ON `paper_trades` (`trade_id`);