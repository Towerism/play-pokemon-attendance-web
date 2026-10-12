CREATE TABLE `staff_assignment` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`league_id` text NOT NULL,
	`session_date` text NOT NULL,
	`tournament_id` text NOT NULL,
	`tournament_label` text NOT NULL,
	`player_id` text NOT NULL,
	`role` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`record_id` text,
	`applied_role` text,
	`assigned_at` integer,
	`removed_at` integer,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `league`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`player_id`) REFERENCES `player`(`player_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `staff_assignment_live_unique` ON `staff_assignment` (`league_id`,`tournament_id`,`player_id`) WHERE "staff_assignment"."removed_at" is null;--> statement-breakpoint
CREATE INDEX `staff_assignment_league_date_idx` ON `staff_assignment` (`league_id`,`session_date`);--> statement-breakpoint
CREATE TABLE `staff_history` (
	`league_id` text NOT NULL,
	`tournament_id` text NOT NULL,
	`player_id` text NOT NULL,
	`tournament_date` text,
	`role` text NOT NULL,
	`source` text NOT NULL,
	`recorded_at` integer NOT NULL,
	PRIMARY KEY(`league_id`, `tournament_id`, `player_id`),
	FOREIGN KEY (`league_id`) REFERENCES `league`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`player_id`) REFERENCES `player`(`player_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `staff_history_league_player_idx` ON `staff_history` (`league_id`,`player_id`);