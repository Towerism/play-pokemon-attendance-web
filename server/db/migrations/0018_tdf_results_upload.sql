CREATE TABLE `tournament_result_upload` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`league_id` text NOT NULL,
	`tournament_id` text NOT NULL,
	`display_id` text,
	`tournament_name` text,
	`session_date` text NOT NULL,
	`filename` text NOT NULL,
	`tdf_file_id` integer,
	`sha256` text NOT NULL,
	`player_count` integer NOT NULL,
	`attendance_upload_id` integer,
	`organizer_replaced` text,
	`tournament_id_filled` integer DEFAULT false NOT NULL,
	`pending_organizer` text,
	`warnings` text DEFAULT '[]' NOT NULL,
	`warnings_fingerprint` text,
	`acknowledged_fingerprint` text,
	`acknowledged_by` text,
	`acknowledged_at` integer,
	`professor_player_id` text,
	`upstream_upload_id` text,
	`upstream_errors` text DEFAULT '[]' NOT NULL,
	`error_code` text,
	`state` text NOT NULL,
	`submission_id` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `league`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tdf_file_id`) REFERENCES `tdf_file`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `tournament_result_upload_tournament_idx` ON `tournament_result_upload` (`league_id`,`tournament_id`);--> statement-breakpoint
ALTER TABLE `submission` ADD `results_upload_id` integer;