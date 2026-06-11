CREATE TABLE `proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`symbol` text NOT NULL,
	`strategy` text NOT NULL,
	`side` text NOT NULL,
	`entry` real NOT NULL,
	`stop_loss` real NOT NULL,
	`take_profit` real NOT NULL,
	`score` real NOT NULL,
	`threshold` real NOT NULL,
	`rr_ratio` real NOT NULL,
	`regime` text NOT NULL,
	`reasoning` text NOT NULL,
	`caveats` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`decision_reason` text,
	`decision_at` integer,
	`snooze_until` integer,
	`outcome_pnl_r` real,
	`outcome_note` text,
	`outcome_at` integer
);
--> statement-breakpoint
ALTER TABLE `bot_positions` ADD `raw_entry_price` real;