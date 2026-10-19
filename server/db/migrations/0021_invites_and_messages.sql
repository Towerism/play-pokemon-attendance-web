-- ADR-0015 §6–§8: invites and reset links, the Discord channel's outbound messages, and integration token scopes.
-- Additive: no table is rebuilt or dropped, so nothing cascades. The rename keeps every token row; existing tokens keep
-- integrations:read.
CREATE TABLE `app_invite` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`league_id` text NOT NULL,
	`secret_hash` text NOT NULL,
	`secret_hint` text NOT NULL,
	`label` text,
	`for_player_id` text,
	`for_user_id` integer,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`accepted_at` integer,
	`accepted_user_id` integer,
	`message_id` integer,
	`delivery` text,
	FOREIGN KEY (`league_id`) REFERENCES `league`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`for_user_id`) REFERENCES `app_user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`accepted_user_id`) REFERENCES `app_user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_invite_secret_hash_unique` ON `app_invite` (`secret_hash`);--> statement-breakpoint
CREATE TABLE `outbound_message` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`league_id` text NOT NULL,
	`player_id` text NOT NULL,
	`text` text NOT NULL,
	`topic` text NOT NULL,
	`ref` text,
	`link_label` text,
	`link_ciphertext` blob,
	`status` text NOT NULL,
	`status_reason` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`delivered_at` integer,
	`handled_at` integer,
	FOREIGN KEY (`league_id`) REFERENCES `league`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `outbound_message_due_idx` ON `outbound_message` (`league_id`,`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `outbound_message_created_idx` ON `outbound_message` (`created_at`);--> statement-breakpoint
ALTER TABLE `app_user` ADD `reverify_required_at` integer;--> statement-breakpoint
ALTER TABLE `integration_token` RENAME COLUMN `scope` TO `scopes`;