ALTER TABLE `submission` ADD `kind` text DEFAULT 'submit' NOT NULL;--> statement-breakpoint
ALTER TABLE `submission` ADD `undo_of` integer;