ALTER TYPE "crm"."ai_usage_status" ADD VALUE 'error';--> statement-breakpoint
ALTER TABLE "crm"."ai_usage" ADD COLUMN "feature" text;--> statement-breakpoint
ALTER TABLE "crm"."ai_usage" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "crm"."ai_usage" ADD COLUMN "error_code" text;