CREATE TABLE "crm"."ai_provider_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"secret_enc" text NOT NULL,
	"secret_hint" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_tested_at" timestamp with time zone,
	"last_test_ok" boolean,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_provider_keys_name_len" CHECK (char_length("crm"."ai_provider_keys"."name") between 2 and 80),
	CONSTRAINT "ai_provider_keys_provider_check" CHECK ("crm"."ai_provider_keys"."provider" in ('anthropic', 'openai', 'google', 'openrouter', 'elevenlabs', 'groq'))
);
--> statement-breakpoint
ALTER TABLE "crm"."ai_provider_keys" ADD CONSTRAINT "ai_provider_keys_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."ai_provider_keys" ADD CONSTRAINT "ai_provider_keys_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_provider_keys_company_provider_idx" ON "crm"."ai_provider_keys" USING btree ("company_id","provider","updated_at");