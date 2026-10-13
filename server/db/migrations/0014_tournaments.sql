CREATE TABLE `planned_tournament` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`league_id` text NOT NULL,
	`schedule_id` integer,
	`slot_position` integer,
	`occurrence_date` text,
	`template_id` integer NOT NULL,
	`local_date` text NOT NULL,
	`start_time` text NOT NULL,
	`series_override` text,
	`overrides` text DEFAULT '{}' NOT NULL,
	`state` text DEFAULT 'planned' NOT NULL,
	`tournament_id` text,
	`last_attempt_at` integer,
	`display_id` text,
	`upstream_status` text,
	`error_code` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `league`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`schedule_id`) REFERENCES `tournament_schedule`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`template_id`) REFERENCES `tournament_template`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `planned_tournament_occurrence_unique` ON `planned_tournament` (`schedule_id`,`slot_position`,`occurrence_date`);--> statement-breakpoint
CREATE UNIQUE INDEX `planned_tournament_tournament_unique` ON `planned_tournament` (`league_id`,`tournament_id`) WHERE "planned_tournament"."tournament_id" is not null;--> statement-breakpoint
CREATE INDEX `planned_tournament_league_date_idx` ON `planned_tournament` (`league_id`,`local_date`);--> statement-breakpoint
CREATE INDEX `planned_tournament_event_idx` ON `planned_tournament` (`league_id`,`template_id`,`local_date`);--> statement-breakpoint
CREATE TABLE `scaffold_slot` (
	`scaffold_id` integer NOT NULL,
	`position` integer NOT NULL,
	`template_id` integer NOT NULL,
	`day_offset` integer NOT NULL,
	`start_time` text,
	PRIMARY KEY(`scaffold_id`, `position`),
	FOREIGN KEY (`scaffold_id`) REFERENCES `tournament_scaffold`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`template_id`) REFERENCES `tournament_template`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tournament_scaffold` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`league_id` text NOT NULL,
	`name` text NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `league`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tournament_scaffold_league_idx` ON `tournament_scaffold` (`league_id`);--> statement-breakpoint
CREATE TABLE `tournament_schedule` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`league_id` text NOT NULL,
	`scaffold_id` integer NOT NULL,
	`rule` text NOT NULL,
	`starts_on` text NOT NULL,
	`ends_on` text,
	`horizon_weeks` integer NOT NULL,
	`created_through` text,
	`paused` integer DEFAULT false NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `league`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`scaffold_id`) REFERENCES `tournament_scaffold`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tournament_schedule_league_idx` ON `tournament_schedule` (`league_id`);--> statement-breakpoint
CREATE TABLE `tournament_schedule_override` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`schedule_id` integer NOT NULL,
	`slot_position` integer NOT NULL,
	`effective_from` text NOT NULL,
	`fields` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`schedule_id`) REFERENCES `tournament_schedule`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tournament_schedule_override_schedule_idx` ON `tournament_schedule_override` (`schedule_id`,`slot_position`);--> statement-breakpoint
CREATE TABLE `tournament_template` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`league_id` text NOT NULL,
	`name` text NOT NULL,
	`organizer_player_id` text NOT NULL,
	`product` text NOT NULL,
	`category` text NOT NULL,
	`event_type` text NOT NULL,
	`series_match` text,
	`venue_id` text NOT NULL,
	`venue_label` text NOT NULL,
	`venue_time_zone` text NOT NULL,
	`venue_country` text NOT NULL,
	`start_time` text NOT NULL,
	`registration` text NOT NULL,
	`contact_email` text,
	`contact_phone` text,
	`details` text,
	`event_website` text,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `league`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tournament_template_league_idx` ON `tournament_template` (`league_id`);