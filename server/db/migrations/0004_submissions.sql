CREATE TABLE `submission` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`league_id` text NOT NULL,
	`session_date` text NOT NULL,
	`play_session_id` text NOT NULL,
	`play_session_label` text NOT NULL,
	`started_by` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text NOT NULL,
	`error` text,
	`retry_of` integer,
	FOREIGN KEY (`league_id`) REFERENCES `league`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `submission_league_date_idx` ON `submission` (`league_id`,`session_date`);--> statement-breakpoint
CREATE TABLE `submission_event` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`submission_id` integer NOT NULL,
	`at` integer NOT NULL,
	`type` text NOT NULL,
	`message` text NOT NULL,
	`done` integer NOT NULL,
	`total` integer NOT NULL,
	FOREIGN KEY (`submission_id`) REFERENCES `submission`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `submission_event_submission_idx` ON `submission_event` (`submission_id`,`id`);--> statement-breakpoint
CREATE TABLE `submission_item` (
	`submission_id` integer NOT NULL,
	`player_id` text NOT NULL,
	`origin` text NOT NULL,
	`outcome` text NOT NULL,
	`error` text,
	`record_id` text,
	`as_staff` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`submission_id`, `player_id`),
	FOREIGN KEY (`submission_id`) REFERENCES `submission`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`player_id`) REFERENCES `player`(`player_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `submission_lock` (
	`league_id` text PRIMARY KEY NOT NULL,
	`submission_id` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `league`(`id`) ON UPDATE no action ON DELETE no action
);
