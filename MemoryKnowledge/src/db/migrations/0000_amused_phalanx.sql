CREATE TABLE `knowledge_code_graph` (
	`code_graph_id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`team_id` text NOT NULL,
	`repo_name` text DEFAULT '' NOT NULL,
	`repo_url` text NOT NULL,
	`branch` text NOT NULL,
	`commit_hash` text,
	`owner_user_id` text,
	`user_id` text,
	`agent_id` text,
	`task_id` text,
	`visibility` text DEFAULT 'team' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`internal_status` text,
	`sync_error` text,
	`stats_json` text,
	`service_url` text,
	`summary` text,
	`version` integer DEFAULT 0 NOT NULL,
	`last_sync_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_kcg_team_repo_branch` ON `knowledge_code_graph` (`service_id`,`team_id`,`repo_url`,`branch`) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `idx_kcg_team_status` ON `knowledge_code_graph` (`service_id`,`team_id`,`status`);--> statement-breakpoint
CREATE TABLE `knowledge_code_graph_audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code_graph_id` text NOT NULL,
	`service_id` text,
	`version` integer DEFAULT 0 NOT NULL,
	`action` text NOT NULL,
	`user_id` text,
	`agent_id` text,
	`detail` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_kcga_cg_version` ON `knowledge_code_graph_audit` (`code_graph_id`,`version`);--> statement-breakpoint
CREATE TABLE `knowledge_code_graph_grant` (
	`code_graph_id` text NOT NULL,
	`team_id` text NOT NULL,
	`grant_type` text DEFAULT 'viewer' NOT NULL,
	PRIMARY KEY(`code_graph_id`, `team_id`)
);
--> statement-breakpoint
CREATE TABLE `knowledge_wiki` (
	`wiki_id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`team_id` text NOT NULL,
	`name` text NOT NULL,
	`source_type` text,
	`source_url` text,
	`owner_user_id` text,
	`user_id` text,
	`agent_id` text,
	`task_id` text,
	`visibility` text DEFAULT 'team' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`internal_status` text,
	`sync_error` text,
	`page_count` integer,
	`service_url` text,
	`summary` text,
	`version` integer DEFAULT 0 NOT NULL,
	`last_sync_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_kwiki_team_name` ON `knowledge_wiki` (`service_id`,`team_id`,`name`) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `idx_kwiki_team_status` ON `knowledge_wiki` (`service_id`,`team_id`,`status`);--> statement-breakpoint
CREATE TABLE `knowledge_wiki_audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`wiki_id` text NOT NULL,
	`service_id` text,
	`version` integer DEFAULT 0 NOT NULL,
	`action` text NOT NULL,
	`user_id` text,
	`agent_id` text,
	`detail` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_kwa_wiki_version` ON `knowledge_wiki_audit` (`wiki_id`,`version`);--> statement-breakpoint
CREATE TABLE `knowledge_wiki_grant` (
	`wiki_id` text NOT NULL,
	`team_id` text NOT NULL,
	`grant_type` text DEFAULT 'viewer' NOT NULL,
	PRIMARY KEY(`wiki_id`, `team_id`)
);
--> statement-breakpoint
CREATE TABLE `llm_binding` (
	`service_id` text PRIMARY KEY NOT NULL,
	`mode` text DEFAULT 'proxy' NOT NULL,
	`proxy_base_url` text,
	`api_key` text,
	`base_url` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL
);
