-- ADR-0015 §5: tournament leases, and the lease a staff or results job ran under. Additive: one new table and one
-- nullable column, so nothing is rebuilt and every row is kept. A connection's leases are deleted with it.
CREATE TABLE `tournament_lease` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`league_id` text NOT NULL,
	`connection_id` integer NOT NULL,
	`tournament_id` text NOT NULL,
	`tournament_label` text NOT NULL,
	`lessee_user_id` integer NOT NULL,
	`granted_by` text NOT NULL,
	`granted_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`ended_at` integer,
	`end_reason` text,
	`notice_message_id` integer,
	`notice_delivery` text,
	FOREIGN KEY (`league_id`) REFERENCES `league`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`connection_id`) REFERENCES `pokemon_connection`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lessee_user_id`) REFERENCES `app_user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tournament_lease_live_idx` ON `tournament_lease` (`tournament_id`) WHERE "tournament_lease"."ended_at" is null;--> statement-breakpoint
CREATE INDEX `tournament_lease_lessee_idx` ON `tournament_lease` (`lessee_user_id`);--> statement-breakpoint
CREATE INDEX `tournament_lease_connection_idx` ON `tournament_lease` (`connection_id`);--> statement-breakpoint
ALTER TABLE `submission` ADD `lease_id` integer;