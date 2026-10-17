ALTER TABLE "crm"."connections" ADD COLUMN "origin" text DEFAULT 'crm' NOT NULL;--> statement-breakpoint
ALTER TABLE "crm"."connections" ADD COLUMN "unlinked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "crm"."connections" ADD COLUMN "unlinked_session_id" text;--> statement-breakpoint
ALTER TABLE "crm"."connections" ADD CONSTRAINT "connections_origin_check" CHECK ("crm"."connections"."origin" in ('crm', 'ai-manager'));