CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`accountId` text NOT NULL,
	`providerId` text NOT NULL,
	`userId` text NOT NULL,
	`accessToken` text,
	`refreshToken` text,
	`idToken` text,
	`accessTokenExpiresAt` integer,
	`refreshTokenExpiresAt` integer,
	`scope` text,
	`password` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `clients` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`phone` text,
	`odp_id` integer,
	`odp_port` integer,
	`lat` real,
	`lng` real,
	`pppoe_username` text,
	`sn_modem` text,
	`wifi_ssid` text,
	`wifi_password` text,
	`wifi_ssid_5g` text,
	`wifi_password_5g` text,
	`lan_status` text,
	`associated_devices` integer,
	`connected_hosts` text,
	`brand` text,
	`model_name` text,
	`hardware_version` text,
	`software_version` text,
	`mac_address` text,
	`wan_ip` text,
	`tx_power` text,
	`temperature` text,
	`voltage` text,
	`rx_power` text,
	`is_online` integer DEFAULT false,
	`offline_reason` text,
	`cable_path` text,
	`client_type` text DEFAULT 'PPPOE',
	`lan_ip` text,
	`connection_request_url` text,
	`last_inform_at` text,
	`wan_config_json` text,
	`wifi_config_json` text,
	`admin_username` text,
	`admin_password` text,
	`raw_modem_params_json` text,
	`modem_profile` text,
	FOREIGN KEY (`odp_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `devices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`parent_id` integer,
	`lat` real,
	`lng` real,
	`capacity` integer,
	`ports_count` integer,
	`cable_path` text
);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expiresAt` integer NOT NULL,
	`token` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`ipAddress` text,
	`userAgent` text,
	`userId` text NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`emailVerified` integer NOT NULL,
	`image` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);
