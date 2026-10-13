CREATE TABLE `integration_token` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`league_id` text NOT NULL,
	`label` text NOT NULL,
	`token_hash` text NOT NULL,
	`token_hint` text NOT NULL,
	`scope` text DEFAULT 'integrations:read' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`league_id`) REFERENCES `league`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integration_token_token_hash_unique` ON `integration_token` (`token_hash`);--> statement-breakpoint
CREATE INDEX `integration_token_league_idx` ON `integration_token` (`league_id`);