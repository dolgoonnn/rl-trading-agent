CREATE TABLE `bot_kill_switch` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`halted` integer DEFAULT false NOT NULL,
	`reason` text,
	`source` text,
	`halted_at` integer,
	`manual_review` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `decision_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` integer NOT NULL,
	`type` text NOT NULL,
	`symbol` text,
	`detail` text
);
--> statement-breakpoint
CREATE TABLE `pnl_cells` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`week_of` integer NOT NULL,
	`regime` text,
	`symbol` text,
	`confluence_bucket` text,
	`exit_reason` text,
	`n` integer,
	`mean_net` real,
	`sum_net` real,
	`win_rate` real,
	`sum_gross` real,
	`sum_funding` real,
	`sum_friction` real,
	`funding_pct_of_gross` real
);
--> statement-breakpoint
CREATE TABLE `skipped_signals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`symbol` text NOT NULL,
	`reason` text NOT NULL,
	`signal_entry` real,
	`score` real,
	`regime` text,
	`detail` text
);
--> statement-breakpoint
ALTER TABLE `bot_trades` ADD `gross_return` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `bot_trades` ADD `friction_return` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `bot_trades` ADD `funding_return` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `bot_trades` ADD `net_return` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `bot_trades` ADD `funding_paid_usdt` real DEFAULT 0 NOT NULL;