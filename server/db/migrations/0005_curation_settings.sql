CREATE TABLE `curation_settings` (
	`league_id` text PRIMARY KEY NOT NULL,
	`promote_min_sightings` integer NOT NULL,
	`stale_after_sessions` integer NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `league`(`id`) ON UPDATE no action ON DELETE no action
);
