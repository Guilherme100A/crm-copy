CREATE TYPE "crm"."ai_agent_goal" AS ENUM('sell', 'schedule', 'answer', 'qualify');--> statement-breakpoint
CREATE TYPE "crm"."ai_agent_personality" AS ENUM('seller', 'support', 'consultative', 'casual');--> statement-breakpoint
CREATE TYPE "crm"."ai_agent_status" AS ENUM('draft', 'active', 'paused');--> statement-breakpoint
CREATE TABLE "crm"."ai_agent_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"title" text NOT NULL,
	"filename" text,
	"blob_key" text NOT NULL,
	"mime" text NOT NULL,
	"size" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."ai_agent_settings" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"settings" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."ai_agent_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"when_text" text DEFAULT '' NOT NULL,
	"action_type" text NOT NULL,
	"action_params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"schedule_mode" text DEFAULT 'now' NOT NULL,
	"silence_amount" integer DEFAULT 1 NOT NULL,
	"silence_unit" text DEFAULT 'days' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."ai_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text DEFAULT 'Leo' NOT NULL,
	"role" text DEFAULT '' NOT NULL,
	"avatar_key" text DEFAULT 'leo-2' NOT NULL,
	"avatar_blob_key" text,
	"status" "crm"."ai_agent_status" DEFAULT 'draft' NOT NULL,
	"primary_goal" "crm"."ai_agent_goal" DEFAULT 'sell' NOT NULL,
	"purpose" text DEFAULT '' NOT NULL,
	"audience" text DEFAULT '' NOT NULL,
	"personality" "crm"."ai_agent_personality" DEFAULT 'seller' NOT NULL,
	"example_messages" text DEFAULT '' NOT NULL,
	"business_rules" text DEFAULT '' NOT NULL,
	"never_talk_about" text DEFAULT '' NOT NULL,
	"use_emojis" boolean DEFAULT true NOT NULL,
	"generated_prompt" text DEFAULT '' NOT NULL,
	"last_generated_prompt" text DEFAULT '' NOT NULL,
	"prompt_edited" boolean DEFAULT false NOT NULL,
	"locked_blocks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model" jsonb,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."ai_collection_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crm"."ai_agent_media" ADD CONSTRAINT "ai_agent_media_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."ai_agent_media" ADD CONSTRAINT "ai_agent_media_agent_id_ai_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "crm"."ai_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."ai_agent_settings" ADD CONSTRAINT "ai_agent_settings_agent_id_ai_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "crm"."ai_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."ai_agent_settings" ADD CONSTRAINT "ai_agent_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."ai_agent_skills" ADD CONSTRAINT "ai_agent_skills_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."ai_agent_skills" ADD CONSTRAINT "ai_agent_skills_agent_id_ai_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "crm"."ai_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."ai_agents" ADD CONSTRAINT "ai_agents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."ai_agents" ADD CONSTRAINT "ai_agents_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."ai_collection_fields" ADD CONSTRAINT "ai_collection_fields_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."ai_collection_fields" ADD CONSTRAINT "ai_collection_fields_agent_id_ai_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "crm"."ai_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_agent_media_company_agent_idx" ON "crm"."ai_agent_media" USING btree ("company_id","agent_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_agent_settings_company_idx" ON "crm"."ai_agent_settings" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "ai_agent_skills_company_agent_idx" ON "crm"."ai_agent_skills" USING btree ("company_id","agent_id","position");--> statement-breakpoint
CREATE INDEX "ai_agents_company_status_idx" ON "crm"."ai_agents" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_collection_fields_agent_key_uq" ON "crm"."ai_collection_fields" USING btree ("agent_id","key");--> statement-breakpoint
CREATE INDEX "ai_collection_fields_company_agent_idx" ON "crm"."ai_collection_fields" USING btree ("company_id","agent_id","position");--> statement-breakpoint
ALTER TABLE "crm"."chats" ADD CONSTRAINT "chats_ai_agent_id_ai_agents_id_fk" FOREIGN KEY ("ai_agent_id") REFERENCES "crm"."ai_agents"("id") ON DELETE set null ON UPDATE no action;