CREATE TABLE `events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`ts` integer NOT NULL,
	`scope_kind` text NOT NULL,
	`session_id` text,
	`run_id` text,
	`tick_id` text,
	`type` text NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_events_id` ON `events` (`id`);--> statement-breakpoint
CREATE INDEX `idx_events_ts` ON `events` (`ts`);--> statement-breakpoint
CREATE INDEX `idx_events_run_seq` ON `events` (`run_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_events_session_seq` ON `events` (`session_id`,`seq`);--> statement-breakpoint
CREATE TABLE `ocean_sessions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`created_ts` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ocean_storage_global` (
	`clog_id` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_ts` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ocean_storage_run` (
	`clog_id` text NOT NULL,
	`run_id` text NOT NULL,
	`value` text NOT NULL,
	`updated_ts` integer NOT NULL,
	PRIMARY KEY(`clog_id`, `run_id`),
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`run_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_storage_run_run` ON `ocean_storage_run` (`run_id`);--> statement-breakpoint
CREATE TABLE `ocean_storage_session` (
	`clog_id` text NOT NULL,
	`session_id` text NOT NULL,
	`value` text NOT NULL,
	`updated_ts` integer NOT NULL,
	PRIMARY KEY(`clog_id`, `session_id`),
	FOREIGN KEY (`session_id`) REFERENCES `ocean_sessions`(`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_storage_session_session` ON `ocean_storage_session` (`session_id`);--> statement-breakpoint
CREATE TABLE `ocean_storage_tick` (
	`clog_id` text NOT NULL,
	`run_id` text NOT NULL,
	`tick_id` text NOT NULL,
	`row_id` text NOT NULL,
	`value` text NOT NULL,
	`updated_ts` integer NOT NULL,
	PRIMARY KEY(`clog_id`, `run_id`, `tick_id`, `row_id`),
	FOREIGN KEY (`run_id`,`tick_id`) REFERENCES `ocean_ticks`(`run_id`,`tick_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_storage_tick_run_tick` ON `ocean_storage_tick` (`run_id`,`tick_id`);--> statement-breakpoint
CREATE INDEX `idx_storage_tick_run` ON `ocean_storage_tick` (`run_id`);--> statement-breakpoint
CREATE TABLE `ocean_ticks` (
	`run_id` text NOT NULL,
	`tick_id` text NOT NULL,
	`created_ts` integer NOT NULL,
	PRIMARY KEY(`run_id`, `tick_id`),
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`run_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_ticks_run` ON `ocean_ticks` (`run_id`);--> statement-breakpoint
CREATE TABLE `runs` (
	`run_id` text PRIMARY KEY NOT NULL,
	`created_ts` integer NOT NULL,
	`updated_ts` integer NOT NULL,
	`session_id` text NOT NULL,
	`status` text NOT NULL,
	`state` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `ocean_sessions`(`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_runs_session` ON `runs` (`session_id`);