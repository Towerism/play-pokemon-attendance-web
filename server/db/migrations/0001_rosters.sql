CREATE TABLE `league` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `player` (
	`player_id` text PRIMARY KEY NOT NULL,
	`display_name` text DEFAULT '' NOT NULL,
	`first_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `player_membership` (
	`league_id` text NOT NULL,
	`player_id` text NOT NULL,
	`is_regular` integer DEFAULT false NOT NULL,
	`regular_since` integer,
	`notes` text,
	PRIMARY KEY(`league_id`, `player_id`),
	FOREIGN KEY (`league_id`) REFERENCES `league`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`player_id`) REFERENCES `player`(`player_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `session_draft` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`league_id` text NOT NULL,
	`session_date` text NOT NULL,
	`play_session_id` text,
	`status` text DEFAULT 'draft' NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `league`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_draft_league_date_unique` ON `session_draft` (`league_id`,`session_date`);--> statement-breakpoint
CREATE TABLE `session_player` (
	`draft_id` integer NOT NULL,
	`player_id` text NOT NULL,
	`source` text NOT NULL,
	`tdf_upload_id` integer,
	PRIMARY KEY(`draft_id`, `player_id`),
	FOREIGN KEY (`draft_id`) REFERENCES `session_draft`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`player_id`) REFERENCES `player`(`player_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sighting` (
	`league_id` text NOT NULL,
	`player_id` text NOT NULL,
	`session_date` text NOT NULL,
	`kind` text NOT NULL,
	PRIMARY KEY(`league_id`, `player_id`, `session_date`, `kind`),
	FOREIGN KEY (`league_id`) REFERENCES `league`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`player_id`) REFERENCES `player`(`player_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sighting_league_date_idx` ON `sighting` (`league_id`,`session_date`);--> statement-breakpoint
INSERT INTO `league` (`id`, `name`) VALUES ('default', 'My league');
