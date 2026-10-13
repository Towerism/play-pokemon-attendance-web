CREATE TABLE `tdf_file` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`league_id` text NOT NULL,
	`sha256` text NOT NULL,
	`filename` text NOT NULL,
	`byte_size` integer NOT NULL,
	`ciphertext` blob NOT NULL,
	`tournament_name` text,
	`tournament_date` text,
	`tournament_display_id` text,
	`kept_for` text DEFAULT '[]' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `league`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tdf_file_league_sha256_unique` ON `tdf_file` (`league_id`,`sha256`);--> statement-breakpoint
ALTER TABLE `tdf_upload` ADD `tdf_file_id` integer REFERENCES tdf_file(id) ON DELETE SET NULL;--> statement-breakpoint
-- A pending preview can't be committed once its staged players are gone (ADR-0012).
DELETE FROM `tdf_upload` WHERE `status` = 'pending';--> statement-breakpoint
DROP TABLE `tdf_upload_player`;