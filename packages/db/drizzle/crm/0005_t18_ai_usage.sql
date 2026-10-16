CREATE TYPE "crm"."ai_price_kind" AS ENUM('llm', 'tts', 'stt');--> statement-breakpoint
CREATE TYPE "crm"."ai_usage_status" AS ENUM('charged', 'refunded');--> statement-breakpoint
CREATE TYPE "crm"."ai_quota_period" AS ENUM('day', 'month');--> statement-breakpoint
CREATE TYPE "crm"."ai_rounding_mode" AS ENUM('ceil', 'floor', 'round');--> statement-breakpoint
CREATE TYPE "crm"."ai_wallet_entry_kind" AS ENUM('credit', 'debit', 'refund', 'adjust');--> statement-breakpoint
CREATE TYPE "crm"."ai_wallet_status" AS ENUM('ok', 'low', 'exhausted');--> statement-breakpoint
CREATE TABLE "crm"."ai_pricing_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"markup_bps" integer NOT NULL,
	"credits_per_usd" integer NOT NULL,
	"rounding_mode" "crm"."ai_rounding_mode" DEFAULT 'ceil' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."ai_quotas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"period" "crm"."ai_quota_period" NOT NULL,
	"max_credits" bigint,
	"max_cost_micros" bigint,
	"max_tokens" bigint,
	"hard" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."ai_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"request_id" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"kind" "crm"."ai_price_kind" DEFAULT 'llm' NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"reasoning_tokens" bigint DEFAULT 0 NOT NULL,
	"units" bigint,
	"cost_micros" bigint NOT NULL,
	"billed_micros" bigint NOT NULL,
	"credits" bigint NOT NULL,
	"price_id" uuid,
	"status" "crm"."ai_usage_status" DEFAULT 'charged' NOT NULL,
	"source" text,
	"source_id" text,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."ai_wallet_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" "crm"."ai_wallet_entry_kind" NOT NULL,
	"amount_credits" bigint NOT NULL,
	"balance_after_credits" bigint NOT NULL,
	"usage_id" uuid,
	"request_id" text,
	"note" text,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."ai_wallets" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"balance_credits" bigint DEFAULT 0 NOT NULL,
	"low_threshold_credits" bigint DEFAULT 0 NOT NULL,
	"max_overrun_credits" bigint DEFAULT 0 NOT NULL,
	"status" "crm"."ai_wallet_status" DEFAULT 'exhausted' NOT NULL,
	"lifetime_credited_credits" bigint DEFAULT 0 NOT NULL,
	"lifetime_spent_credits" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."llm_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"kind" "crm"."ai_price_kind" DEFAULT 'llm' NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"input_per_mtok_micros" bigint DEFAULT 0 NOT NULL,
	"output_per_mtok_micros" bigint DEFAULT 0 NOT NULL,
	"cache_read_per_mtok_micros" bigint,
	"cache_write_per_mtok_micros" bigint,
	"reasoning_per_mtok_micros" bigint,
	"unit_price_micros" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crm"."ai_pricing_settings" ADD CONSTRAINT "ai_pricing_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."ai_quotas" ADD CONSTRAINT "ai_quotas_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."ai_usage" ADD CONSTRAINT "ai_usage_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."ai_usage" ADD CONSTRAINT "ai_usage_price_id_llm_prices_id_fk" FOREIGN KEY ("price_id") REFERENCES "crm"."llm_prices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."ai_usage" ADD CONSTRAINT "ai_usage_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."ai_wallet_entries" ADD CONSTRAINT "ai_wallet_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."ai_wallet_entries" ADD CONSTRAINT "ai_wallet_entries_usage_id_ai_usage_id_fk" FOREIGN KEY ("usage_id") REFERENCES "crm"."ai_usage"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."ai_wallet_entries" ADD CONSTRAINT "ai_wallet_entries_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."ai_wallets" ADD CONSTRAINT "ai_wallets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_pricing_settings_company_uq" ON "crm"."ai_pricing_settings" USING btree ("company_id") WHERE "crm"."ai_pricing_settings"."company_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_pricing_settings_global_uq" ON "crm"."ai_pricing_settings" USING btree ((true)) WHERE "crm"."ai_pricing_settings"."company_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_quotas_company_period_uq" ON "crm"."ai_quotas" USING btree ("company_id","period");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_usage_request_uq" ON "crm"."ai_usage" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "ai_usage_company_created_idx" ON "crm"."ai_usage" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_wallet_entries_company_created_idx" ON "crm"."ai_wallet_entries" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_wallet_entries_refund_usage_uq" ON "crm"."ai_wallet_entries" USING btree ("usage_id") WHERE "crm"."ai_wallet_entries"."kind" = 'refund';--> statement-breakpoint
CREATE UNIQUE INDEX "ai_wallet_entries_debit_usage_uq" ON "crm"."ai_wallet_entries" USING btree ("usage_id") WHERE "crm"."ai_wallet_entries"."kind" = 'debit' and "crm"."ai_wallet_entries"."usage_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "llm_prices_model_from_uq" ON "crm"."llm_prices" USING btree ("provider","model","kind","effective_from");