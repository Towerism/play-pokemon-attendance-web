CREATE TABLE `tdf_upload` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`draft_id` integer NOT NULL,
	`filename` text NOT NULL,
	`sha256` text NOT NULL,
	`tournament_name` text,
	`tournament_date` text,
	`player_count` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`committed_at` integer,
	FOREIGN KEY (`draft_id`) REFERENCES `session_draft`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tdf_upload_draft_sha256_unique` ON `tdf_upload` (`draft_id`,`sha256`);--> statement-breakpoint
CREATE TABLE `tdf_upload_player` (
	`upload_id` integer NOT NULL,
	`player_id` text NOT NULL,
	`name` text NOT NULL,
	PRIMARY KEY(`upload_id`, `player_id`),
	FOREIGN KEY (`upload_id`) REFERENCES `tdf_upload`(`id`) ON UPDATE no action ON DELETE cascade
);
