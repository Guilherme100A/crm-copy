CREATE TABLE "crm"."tracked_link_clicks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"link_id" uuid NOT NULL,
	"code" text NOT NULL,
	"fbclid" text,
	"ad_id" text,
	"fbc" text,
	"fbp" text,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"utm_content" text,
	"utm_term" text,
	"client_ip" text,
	"user_agent" text,
	"contact_id" uuid,
	"matched_at" timestamp with time zone,
	"match_confidence" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."tracked_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"connection_id" uuid,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"phone" text,
	"message" text DEFAULT '' NOT NULL,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"utm_content" text,
	"utm_term" text,
	"active" boolean DEFAULT true NOT NULL,
	"code_mode" text DEFAULT 'visible' NOT NULL,
	"match_window_minutes" integer DEFAULT 10 NOT NULL,
	"probable_match" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracked_links_code_mode_ck" CHECK ("crm"."tracked_links"."code_mode" in ('visible', 'discreet', 'off')),
	CONSTRAINT "tracked_links_window_ck" CHECK ("crm"."tracked_links"."match_window_minutes" between 1 and 1440),
	CONSTRAINT "tracked_links_slug_ck" CHECK ("crm"."tracked_links"."slug" ~ '^[a-z0-9][a-z0-9-]{2,62}$'),
	CONSTRAINT "tracked_links_phone_ck" CHECK ("crm"."tracked_links"."phone" is null or "crm"."tracked_links"."phone" ~ '^[0-9]{8,15}$'),
	CONSTRAINT "tracked_links_name_ck" CHECK (char_length("crm"."tracked_links"."name") between 2 and 120)
);
--> statement-breakpoint
ALTER TABLE "crm"."sales" ADD COLUMN "attribution_confidence" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "crm"."sales" ADD COLUMN "attribution_method" text;--> statement-breakpoint
ALTER TABLE "crm"."capi_event_log" ADD COLUMN "event_time" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "crm"."capi_event_log" ADD COLUMN "identifiers" text[];--> statement-breakpoint
ALTER TABLE "crm"."capi_event_log" ADD COLUMN "match_score" integer;--> statement-breakpoint
ALTER TABLE "crm"."capi_event_log" ADD COLUMN "test_event" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "crm"."capi_event_log" ADD COLUMN "custom_data" jsonb;--> statement-breakpoint
ALTER TABLE "crm"."pixel_configs" ADD COLUMN "page_id" text;--> statement-breakpoint
ALTER TABLE "crm"."pixel_configs" ADD COLUMN "whatsapp_business_account_id" text;--> statement-breakpoint
ALTER TABLE "crm"."pixel_configs" ADD COLUMN "test_event_code" text;--> statement-breakpoint
ALTER TABLE "crm"."pixel_configs" ADD COLUMN "default_country" text DEFAULT 'br' NOT NULL;--> statement-breakpoint
ALTER TABLE "crm"."pixel_configs" ADD COLUMN "auto_lead_on_ad" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "crm"."pixel_configs" ADD COLUMN "bm_status" text;--> statement-breakpoint
ALTER TABLE "crm"."pixel_configs" ADD COLUMN "bm_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "crm"."pixel_configs" ADD COLUMN "bm_error" text;--> statement-breakpoint
ALTER TABLE "crm"."contact_attribution" ADD COLUMN "confidence" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "crm"."contact_attribution" ADD COLUMN "method" text;--> statement-breakpoint
ALTER TABLE "crm"."contact_attribution" ADD COLUMN "confidence_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "crm"."contact_attribution" ADD COLUMN "confidence_source_id" text;--> statement-breakpoint
ALTER TABLE "crm"."contact_attribution" ADD COLUMN "confidence_click_id" uuid;--> statement-breakpoint
ALTER TABLE "crm"."contact_attribution" ADD COLUMN "confidence_history" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "crm"."tracked_link_clicks" ADD CONSTRAINT "tracked_link_clicks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."tracked_link_clicks" ADD CONSTRAINT "tracked_link_clicks_link_id_tracked_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "crm"."tracked_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."tracked_link_clicks" ADD CONSTRAINT "tracked_link_clicks_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "crm"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."tracked_links" ADD CONSTRAINT "tracked_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."tracked_links" ADD CONSTRAINT "tracked_links_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "crm"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tracked_link_clicks_code_uq" ON "crm"."tracked_link_clicks" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "tracked_link_clicks_link_idx" ON "crm"."tracked_link_clicks" USING btree ("link_id","created_at");--> statement-breakpoint
CREATE INDEX "tracked_link_clicks_contact_idx" ON "crm"."tracked_link_clicks" USING btree ("contact_id","matched_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tracked_links_slug_uq" ON "crm"."tracked_links" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "tracked_links_company_idx" ON "crm"."tracked_links" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "capi_event_log_pixel_created_idx" ON "crm"."capi_event_log" USING btree ("pixel_config_id","created_at");--> statement-breakpoint
ALTER TABLE "crm"."pixel_configs" ADD CONSTRAINT "pixel_configs_page_id_ck" CHECK ("crm"."pixel_configs"."page_id" is null or "crm"."pixel_configs"."page_id" ~ '^[0-9]+$');--> statement-breakpoint
ALTER TABLE "crm"."pixel_configs" ADD CONSTRAINT "pixel_configs_waba_id_ck" CHECK ("crm"."pixel_configs"."whatsapp_business_account_id" is null or "crm"."pixel_configs"."whatsapp_business_account_id" ~ '^[0-9]+$');--> statement-breakpoint
ALTER TABLE "crm"."pixel_configs" ADD CONSTRAINT "pixel_configs_country_ck" CHECK ("crm"."pixel_configs"."default_country" ~ '^[a-z]{2}$');--> statement-breakpoint
ALTER TABLE "crm"."pixel_configs" ADD CONSTRAINT "pixel_configs_bm_status_ck" CHECK ("crm"."pixel_configs"."bm_status" is null or "crm"."pixel_configs"."bm_status" in ('accepted', 'rejected'));--> statement-breakpoint
-- Revisão 3: vendas e contatos já atribuídos antes dos níveis de confiança vieram do cartão do anúncio (CTWA) ou do
-- source_id informado: ficam confirmed_native (método legacy) para o ROAS por anúncio não mudar.
UPDATE "crm"."sales" SET "attribution_confidence" = 'confirmed_native', "attribution_method" = 'legacy' WHERE "source_id" IS NOT NULL AND btrim("source_id") <> '';--> statement-breakpoint
UPDATE "crm"."contact_attribution" SET "confidence" = 'confirmed_native', "method" = 'legacy', "confidence_at" = "last_at", "confidence_source_id" = coalesce("last_source_id", "first_source_id") WHERE coalesce("last_ctwa_clid", "first_ctwa_clid", "last_source_id", "first_source_id") IS NOT NULL;
