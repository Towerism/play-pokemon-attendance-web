CREATE TABLE `calendar_feed` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`league_id` text NOT NULL,
	`kind` text NOT NULL,
	`user_id` integer,
	`token_sha256` text NOT NULL,
	`hint` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_read_at` integer,
	FOREIGN KEY (`league_id`) REFERENCES `league`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `app_user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "calendar_feed_user_matches_kind" CHECK(("calendar_feed"."kind" = 'public' and "calendar_feed"."user_id" is null) or ("calendar_feed"."kind" = 'user' and "calendar_feed"."user_id" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_feed_token_sha256_unique` ON `calendar_feed` (`token_sha256`);--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_feed_one_public` ON `calendar_feed` (`league_id`) WHERE "calendar_feed"."kind" = 'public';--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_feed_one_per_user` ON `calendar_feed` (`league_id`,`user_id`) WHERE "calendar_feed"."kind" = 'user';--> statement-breakpoint
CREATE TABLE `calendar_snapshot` (
	`league_id` text PRIMARY KEY NOT NULL,
	`built_at` integer NOT NULL,
	`events` text NOT NULL,
	`sources` text NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `league`(`id`) ON UPDATE no action ON DELETE no action
);
