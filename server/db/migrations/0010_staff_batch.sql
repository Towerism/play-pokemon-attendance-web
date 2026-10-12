CREATE TABLE `staff_batch` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`league_id` text NOT NULL,
	`session_date` text NOT NULL,
	`started_by` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text DEFAULT 'running' NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `league`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `staff_batch_league_date_status_idx` ON `staff_batch` (`league_id`,`session_date`,`status`);--> statement-breakpoint
CREATE TABLE `staff_batch_item` (
	`batch_id` integer NOT NULL,
	`position` integer NOT NULL,
	`tournament_id` text NOT NULL,
	`tournament_label` text NOT NULL,
	`status` text DEFAULT 'waiting' NOT NULL,
	`submission_id` integer,
	`refusal_code` text,
	`refusal_message` text,
	PRIMARY KEY(`batch_id`, `position`),
	FOREIGN KEY (`batch_id`) REFERENCES `staff_batch`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`submission_id`) REFERENCES `submission`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `staff_batch_item_tournament_uq` ON `staff_batch_item` (`batch_id`,`tournament_id`);