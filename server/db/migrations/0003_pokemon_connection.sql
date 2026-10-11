CREATE TABLE `pokemon_connection` (
	`league_id` text PRIMARY KEY NOT NULL,
	`ptc_user_id` text NOT NULL,
	`refresh_token_ciphertext` blob NOT NULL,
	`status` text NOT NULL,
	`status_reason` text,
	`connected_at` integer NOT NULL,
	`last_refreshed_at` integer NOT NULL,
	`activity_group_id` text,
	`activity_group_name` text,
	`activity_group_display_id` text,
	`activity_group_can_submit` integer,
	FOREIGN KEY (`league_id`) REFERENCES `league`(`id`) ON UPDATE no action ON DELETE no action
);
