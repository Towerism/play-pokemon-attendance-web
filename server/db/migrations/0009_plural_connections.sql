ALTER TABLE `pokemon_connection` RENAME TO `__v1_pokemon_connection`;--> statement-breakpoint
CREATE TABLE `pokemon_connection` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`professor_player_id` text,
	`professor_name` text,
	`ptc_user_id` text NOT NULL,
	`refresh_token_ciphertext` blob NOT NULL,
	`status` text NOT NULL,
	`status_reason` text,
	`connected_at` integer NOT NULL,
	`last_refreshed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pokemon_connection_professor_player_id_unique` ON `pokemon_connection` (`professor_player_id`);--> statement-breakpoint
CREATE TABLE `league_upstream` (
	`league_id` text PRIMARY KEY NOT NULL,
	`connection_id` integer NOT NULL,
	`activity_group_id` text NOT NULL,
	`activity_group_name` text NOT NULL,
	`activity_group_display_id` text,
	`activity_group_can_submit` integer NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `league`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`connection_id`) REFERENCES `pokemon_connection`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- ADR-0008: the v1 connection becomes an unidentified professor connection. Its token is still sealed with the
-- league id; a boot step re-seals it under the new AAD before anything refreshes it.
INSERT INTO `pokemon_connection` (`ptc_user_id`, `refresh_token_ciphertext`, `status`, `status_reason`, `connected_at`, `last_refreshed_at`)
	SELECT `ptc_user_id`, `refresh_token_ciphertext`, `status`, `status_reason`, `connected_at`, `last_refreshed_at`
	FROM `__v1_pokemon_connection` ORDER BY `league_id`;--> statement-breakpoint
INSERT INTO `league_upstream` (`league_id`, `connection_id`, `activity_group_id`, `activity_group_name`, `activity_group_display_id`, `activity_group_can_submit`)
	SELECT v.`league_id`, c.`id`, v.`activity_group_id`, COALESCE(v.`activity_group_name`, v.`activity_group_id`), v.`activity_group_display_id`, COALESCE(v.`activity_group_can_submit`, 0)
	FROM `__v1_pokemon_connection` v
	JOIN `pokemon_connection` c ON c.`ptc_user_id` = v.`ptc_user_id` AND c.`refresh_token_ciphertext` = v.`refresh_token_ciphertext`
	WHERE v.`activity_group_id` IS NOT NULL;--> statement-breakpoint
DROP TABLE `__v1_pokemon_connection`;--> statement-breakpoint
ALTER TABLE `submission` ADD `professor_player_id` text;--> statement-breakpoint
ALTER TABLE `submission` ADD `professor_name` text;
