CREATE TABLE "crm"."ai_voices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"language" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider" text DEFAULT 'elevenlabs' NOT NULL,
	"provider_voice_id" text NOT NULL,
	"samples_count" integer NOT NULL,
	"samples" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"kept_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crm"."ai_voices" ADD CONSTRAINT "ai_voices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."ai_voices" ADD CONSTRAINT "ai_voices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_voices_company_idx" ON "crm"."ai_voices" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_voices_provider_voice_uq" ON "crm"."ai_voices" USING btree ("company_id","provider","provider_voice_id");