CREATE TABLE `requirement_manual_cover` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`requirement_id` integer NOT NULL,
	`period_start` text NOT NULL,
	`note` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`requirement_id`) REFERENCES `tournament_requirement`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `requirement_manual_cover_period_unique` ON `requirement_manual_cover` (`requirement_id`,`period_start`);--> statement-breakpoint
CREATE TABLE `tournament_requirement` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`league_id` text NOT NULL,
	`series_match` text NOT NULL,
	`product` text NOT NULL,
	`cadence` text NOT NULL,
	`min_count` integer DEFAULT 1 NOT NULL,
	`warn_days` integer NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `league`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tournament_requirement_league_idx` ON `tournament_requirement` (`league_id`);