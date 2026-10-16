CREATE SCHEMA IF NOT EXISTS "crm";
--> statement-breakpoint
CREATE TYPE "crm"."member_role" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint
CREATE TYPE "crm"."system_role" AS ENUM('user', 'platform_admin', 'support');--> statement-breakpoint
CREATE TABLE "crm"."api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_by_user_id" uuid,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"detail" jsonb,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"user_agent" text,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"time_zone" text DEFAULT 'America/Sao_Paulo' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deactivated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."company_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "crm"."member_role" DEFAULT 'member' NOT NULL,
	"permission_keys" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."password_resets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."platform_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"system_role" "crm"."system_role" DEFAULT 'user' NOT NULL,
	"locale" text DEFAULT 'pt-BR' NOT NULL,
	"avatar_key" text,
	"last_company_id" uuid,
	"referral_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crm"."api_tokens" ADD CONSTRAINT "api_tokens_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."api_tokens" ADD CONSTRAINT "api_tokens_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."audit_logs" ADD CONSTRAINT "audit_logs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "crm"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."company_members" ADD CONSTRAINT "company_members_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."company_members" ADD CONSTRAINT "company_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "crm"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."password_resets" ADD CONSTRAINT "password_resets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "crm"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."platform_settings" ADD CONSTRAINT "platform_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."users" ADD CONSTRAINT "users_last_company_id_companies_id_fk" FOREIGN KEY ("last_company_id") REFERENCES "crm"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_token_hash_uq" ON "crm"."api_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "api_tokens_company_idx" ON "crm"."api_tokens" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_company_created_idx" ON "crm"."audit_logs" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "crm"."audit_logs" USING btree ("actor_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_sessions_token_hash_uq" ON "crm"."auth_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_idx" ON "crm"."auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "companies_slug_uq" ON "crm"."companies" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "company_members_company_user_uq" ON "crm"."company_members" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "company_members_one_owner_uq" ON "crm"."company_members" USING btree ("company_id") WHERE "crm"."company_members"."role" = 'owner';--> statement-breakpoint
CREATE INDEX "company_members_user_idx" ON "crm"."company_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "password_resets_token_hash_uq" ON "crm"."password_resets" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "password_resets_user_idx" ON "crm"."password_resets" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_uq" ON "crm"."users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_referral_code_uq" ON "crm"."users" USING btree ("referral_code");