-- ADR-0015 §9, professor logins. Forward-only: back up /data before upgrading.
-- The migrator runs this inside a transaction, where PRAGMA foreign_keys = OFF does nothing, and the app opens the
-- database with foreign keys on. Dropping a parent table deletes its rows first and fires ON DELETE CASCADE on its
-- children, so the steps go in this order: nothing may still reference a table when it is dropped.

-- 1. Roles. The setup account (the lowest id) becomes the owner.
ALTER TABLE `app_user` ADD `role` text DEFAULT 'professor' NOT NULL;--> statement-breakpoint
ALTER TABLE `app_user` ADD `removed_at` integer;--> statement-breakpoint
ALTER TABLE `app_user` ADD `last_sign_in_at` integer;--> statement-breakpoint
UPDATE `app_user` SET `role` = 'owner' WHERE `id` = (SELECT min(`id`) FROM `app_user`);--> statement-breakpoint
CREATE UNIQUE INDEX `app_user_one_owner` ON `app_user` (`role`) WHERE "app_user"."role" = 'owner';--> statement-breakpoint

-- 2. Keep the old binding in a table with no foreign key, for seeding league_membership in step 5.
CREATE TABLE `__binding` AS SELECT `connection_id`, `activity_group_can_submit` FROM `league_upstream`;--> statement-breakpoint

-- 3. league_upstream keeps only the activity group. It is a child of pokemon_connection, so dropping it deletes nothing else.
CREATE TABLE `__new_league_upstream` (
	`league_id` text PRIMARY KEY NOT NULL,
	`activity_group_id` text NOT NULL,
	`activity_group_name` text NOT NULL,
	`activity_group_display_id` text,
	FOREIGN KEY (`league_id`) REFERENCES `league`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_league_upstream` (`league_id`, `activity_group_id`, `activity_group_name`, `activity_group_display_id`)
	SELECT `league_id`, `activity_group_id`, `activity_group_name`, `activity_group_display_id` FROM `league_upstream`;--> statement-breakpoint
DROP TABLE `league_upstream`;--> statement-breakpoint
ALTER TABLE `__new_league_upstream` RENAME TO `league_upstream`;--> statement-breakpoint

-- 4. pokemon_connection gains its user. Nothing references it any more, so the drop cascades nowhere. Every column is
-- copied, id included: the id is the token vault's AAD (pokemon_connection:<id>), and a new id would make the token
-- unreadable.
CREATE TABLE `__new_pokemon_connection` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`claimed_from_user_id` integer,
	`claimed_at` integer,
	`professor_player_id` text,
	`professor_name` text,
	`professor_full_name` text,
	`ptc_user_id` text NOT NULL,
	`refresh_token_ciphertext` blob NOT NULL,
	`status` text NOT NULL,
	`status_reason` text,
	`connected_at` integer NOT NULL,
	`last_refreshed_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `app_user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`claimed_from_user_id`) REFERENCES `app_user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_pokemon_connection` (`id`, `user_id`, `professor_player_id`, `professor_name`, `professor_full_name`, `ptc_user_id`,
		`refresh_token_ciphertext`, `status`, `status_reason`, `connected_at`, `last_refreshed_at`)
	SELECT `id`, (SELECT `id` FROM `app_user` WHERE `role` = 'owner'), `professor_player_id`, `professor_name`, `professor_full_name`, `ptc_user_id`,
		`refresh_token_ciphertext`, `status`, `status_reason`, `connected_at`, `last_refreshed_at`
	FROM `pokemon_connection`;--> statement-breakpoint
DROP TABLE `pokemon_connection`;--> statement-breakpoint
ALTER TABLE `__new_pokemon_connection` RENAME TO `pokemon_connection`;--> statement-breakpoint
CREATE UNIQUE INDEX `pokemon_connection_professor_player_id_unique` ON `pokemon_connection` (`professor_player_id`);--> statement-breakpoint

-- 5. Membership: the connection that submitted before stays a member with its old permission, so Submit works at once.
-- Every other connection is unknown until the keep-alive reads it (checked_at null).
CREATE TABLE `league_membership` (
	`connection_id` integer PRIMARY KEY NOT NULL,
	`league_id` text NOT NULL,
	`status` text NOT NULL,
	`can_submit` integer DEFAULT false NOT NULL,
	`checked_at` integer,
	FOREIGN KEY (`connection_id`) REFERENCES `pokemon_connection`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`league_id`) REFERENCES `league`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `league_membership` (`connection_id`, `league_id`, `status`, `can_submit`)
	SELECT c.`id`, 'default',
		CASE WHEN b.`connection_id` IS NULL THEN 'unknown' ELSE 'member' END,
		COALESCE(b.`activity_group_can_submit`, 0)
	FROM `pokemon_connection` c LEFT JOIN `__binding` b ON b.`connection_id` = c.`id`;--> statement-breakpoint
DROP TABLE `__binding`;
