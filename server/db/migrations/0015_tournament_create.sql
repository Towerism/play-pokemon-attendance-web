CREATE TABLE `submission_tournament_item` (
	`submission_id` integer NOT NULL,
	`position` integer NOT NULL,
	`planned_tournament_id` integer,
	`tournament_id` text,
	`label` text NOT NULL,
	`outcome` text NOT NULL,
	`sent_at` integer,
	`short_notice` integer DEFAULT false NOT NULL,
	`error_code` text,
	`error` text,
	`support` text,
	PRIMARY KEY(`submission_id`, `position`),
	FOREIGN KEY (`submission_id`) REFERENCES `submission`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `submission` ADD `through_schedule_id` integer;--> statement-breakpoint
ALTER TABLE `submission` ADD `through_date` text;