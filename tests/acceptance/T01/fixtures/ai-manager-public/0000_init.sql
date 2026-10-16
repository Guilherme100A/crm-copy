CREATE TYPE "public"."message_direction" AS ENUM('outbound', 'inbound');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('queued', 'processing', 'sent', 'delivered', 'read', 'failed', 'retrying', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."proxy_protocol" AS ENUM('http', 'https', 'socks5');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('NEW', 'WARMING', 'STABLE', 'DEGRADED', 'PAUSED', 'DISCONNECTED');--> statement-breakpoint
CREATE TYPE "public"."webhook_channel" AS ENUM('discord', 'telegram', 'email', 'http');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text,
	"phone" text NOT NULL,
	"consent" boolean DEFAULT false NOT NULL,
	"consent_at" timestamp with time zone,
	"consent_source" text,
	"opt_out" boolean DEFAULT false NOT NULL,
	"last_contact_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_phone_unique" UNIQUE("phone"),
	CONSTRAINT "contacts_phone_e164_check" CHECK ("contacts"."phone" ~ '^\+[1-9][0-9]{1,14}$')
);
--> statement-breakpoint
CREATE TABLE "health_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"type" text NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"message_id" uuid NOT NULL,
	"from_status" "message_status",
	"to_status" "message_status" NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"contact_id" uuid,
	"direction" "message_direction" DEFAULT 'outbound' NOT NULL,
	"phone" text NOT NULL,
	"content" jsonb NOT NULL,
	"status" "message_status" DEFAULT 'queued' NOT NULL,
	"transport_message_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proxies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text,
	"protocol" "proxy_protocol" NOT NULL,
	"host" text NOT NULL,
	"port" integer NOT NULL,
	"username" text,
	"password_ciphertext" "bytea",
	"password_iv" "bytea",
	"password_auth_tag" "bytea",
	"password_key_version" integer,
	"available" boolean DEFAULT true NOT NULL,
	"last_check_at" timestamp with time zone,
	"last_error" text,
	"error_count" integer DEFAULT 0 NOT NULL,
	"last_changed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proxies_port_check" CHECK ("proxies"."port" between 1 and 65535)
);
--> statement-breakpoint
CREATE TABLE "session_credentials" (
	"session_id" uuid NOT NULL,
	"key_type" text NOT NULL,
	"key_id" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"auth_tag" "bytea" NOT NULL,
	"key_version" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_credentials_pk" PRIMARY KEY("session_id","key_type","key_id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"status" "session_status" DEFAULT 'NEW' NOT NULL,
	"proxy_id" uuid,
	"note" text,
	"requires_restart" boolean DEFAULT false NOT NULL,
	"warmup_started_at" timestamp with time zone,
	"last_connected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_proxy_id_unique" UNIQUE("proxy_id")
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"channel" "webhook_channel" NOT NULL,
	"url" text NOT NULL,
	"secret" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"events" text[] DEFAULT '{}'::text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "health_events" ADD CONSTRAINT "health_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_events" ADD CONSTRAINT "message_events_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_credentials" ADD CONSTRAINT "session_credentials_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_proxy_id_proxies_id_fk" FOREIGN KEY ("proxy_id") REFERENCES "public"."proxies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_created_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "health_events_session_created_idx" ON "health_events" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "message_events_message_id_idx" ON "message_events" USING btree ("message_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_session_status_idx" ON "messages" USING btree ("session_id","status");--> statement-breakpoint
CREATE INDEX "messages_transport_message_id_idx" ON "messages" USING btree ("transport_message_id");--> statement-breakpoint
CREATE INDEX "sessions_status_idx" ON "sessions" USING btree ("status");