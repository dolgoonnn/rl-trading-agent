CREATE TABLE `candles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol` text NOT NULL,
	`timeframe` text NOT NULL,
	`timestamp` integer NOT NULL,
	`open` real NOT NULL,
	`high` real NOT NULL,
	`low` real NOT NULL,
	`close` real NOT NULL,
	`volume` real NOT NULL
);
--> statement-breakpoint
CREATE TABLE `flashcards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chunk_id` integer,
	`type` text NOT NULL,
	`front` text NOT NULL,
	`back` text NOT NULL,
	`tags` text,
	`state` text DEFAULT 'new' NOT NULL,
	`difficulty` real DEFAULT 0,
	`stability` real DEFAULT 0,
	`due` integer,
	`last_review` integer,
	`reps` integer DEFAULT 0,
	`lapses` integer DEFAULT 0,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`chunk_id`) REFERENCES `knowledge_chunks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `ict_concepts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`description` text,
	`dependencies` text,
	`phase` integer
);
--> statement-breakpoint
CREATE TABLE `ict_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`source` text,
	`source_url` text,
	`source_timestamp` text,
	`conditions` text NOT NULL,
	`entry_logic` text NOT NULL,
	`exit_logic` text NOT NULL,
	`concepts` text,
	`kill_zones` text,
	`direction` text,
	`is_active` integer DEFAULT true NOT NULL,
	`confidence` text DEFAULT 'learning' NOT NULL,
	`total_triggers` integer DEFAULT 0 NOT NULL,
	`approved_trades` integer DEFAULT 0 NOT NULL,
	`wins` integer DEFAULT 0 NOT NULL,
	`losses` integer DEFAULT 0 NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `knowledge_chunks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`content` text NOT NULL,
	`source_type` text NOT NULL,
	`source_url` text,
	`video_id` text,
	`timestamp` text,
	`concept` text,
	`section` text,
	`file_path` text,
	`embedding` text,
	`token_count` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `setup_fingerprints` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`signature` text NOT NULL,
	`bias` text NOT NULL,
	`direction` text NOT NULL,
	`has_liquidity_sweep` integer NOT NULL,
	`has_choch` integer NOT NULL,
	`has_order_block` integer NOT NULL,
	`has_fvg` integer NOT NULL,
	`in_ote` integer NOT NULL,
	`in_kill_zone` integer NOT NULL,
	`rr_bucket` text NOT NULL,
	`confluence_count` integer NOT NULL,
	`total_trades` integer DEFAULT 0 NOT NULL,
	`wins` integer DEFAULT 0 NOT NULL,
	`losses` integer DEFAULT 0 NOT NULL,
	`total_pnl_r` real DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `setup_fingerprints_signature_unique` ON `setup_fingerprints` (`signature`);--> statement-breakpoint
CREATE TABLE `setup_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`signature` text NOT NULL,
	`symbol` text NOT NULL,
	`timeframe` text NOT NULL,
	`timestamp` integer NOT NULL,
	`entry_price` real NOT NULL,
	`stop_loss` real NOT NULL,
	`take_profit` real NOT NULL,
	`exit_price` real,
	`outcome` text NOT NULL,
	`pnl_r` real,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `trade_suggestions` (
	`id` text PRIMARY KEY NOT NULL,
	`rule_id` text NOT NULL,
	`symbol` text NOT NULL,
	`direction` text NOT NULL,
	`entry_price` real NOT NULL,
	`stop_loss` real NOT NULL,
	`take_profit` real NOT NULL,
	`risk_reward` real NOT NULL,
	`htf_bias` text,
	`kill_zone` text,
	`confluence_score` integer,
	`reasoning` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`outcome` text,
	`exit_price` real,
	`pnl_r` real,
	`triggered_at` integer NOT NULL,
	`responded_at` integer,
	`closed_at` integer
);
--> statement-breakpoint
CREATE TABLE `trades` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`timeframe` text NOT NULL,
	`direction` text NOT NULL,
	`status` text NOT NULL,
	`outcome` text NOT NULL,
	`entry_time` integer NOT NULL,
	`exit_time` integer,
	`entry_price` real NOT NULL,
	`stop_loss` real NOT NULL,
	`take_profit` real NOT NULL,
	`exit_price` real,
	`risk_amount` real NOT NULL,
	`risk_percent` real NOT NULL,
	`planned_rr` real NOT NULL,
	`actual_rr` real,
	`pnl` real,
	`pnl_percent` real,
	`htf_bias` text NOT NULL,
	`setup_type` text NOT NULL,
	`kill_zone` text,
	`entry_reason` text NOT NULL,
	`exit_reason` text,
	`notes` text,
	`screenshots` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `video_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`video_id` text NOT NULL,
	`title` text,
	`channel_name` text,
	`playlist_id` text,
	`playlist_name` text,
	`duration` integer,
	`published_at` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`error_message` text,
	`transcript_path` text,
	`processed_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `video_sources_video_id_unique` ON `video_sources` (`video_id`);