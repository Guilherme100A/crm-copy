CREATE TABLE "crm"."contact_attribution" (
	"contact_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"first_utm_source" text,
	"first_utm_medium" text,
	"first_utm_campaign" text,
	"first_utm_content" text,
	"first_utm_term" text,
	"first_ctwa_clid" text,
	"first_source_id" text,
	"first_source_url" text,
	"first_at" timestamp with time zone NOT NULL,
	"first_sale_source_id" uuid,
	"last_utm_source" text,
	"last_utm_medium" text,
	"last_utm_campaign" text,
	"last_utm_content" text,
	"last_utm_term" text,
	"last_ctwa_clid" text,
	"last_source_id" text,
	"last_source_url" text,
	"last_at" timestamp with time zone NOT NULL,
	"last_sale_source_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."inbound_sale_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"company_id" uuid NOT NULL,
	"sale_source_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"raw_body" text NOT NULL,
	"sale_event" jsonb,
	"error" text,
	"missing" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sale_id" uuid,
	"contact_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbound_sale_events_status_ck" CHECK ("crm"."inbound_sale_events"."status" in ('pending', 'processed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "crm"."sale_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"token" text NOT NULL,
	"hmac_secret_enc" text,
	"mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"amount_unit" text DEFAULT 'decimal' NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sale_sources_name_len" CHECK (char_length("crm"."sale_sources"."name") between 2 and 120),
	CONSTRAINT "sale_sources_amount_unit_ck" CHECK ("crm"."sale_sources"."amount_unit" in ('decimal', 'cents'))
);
--> statement-breakpoint
ALTER TABLE "crm"."contact_attribution" ADD CONSTRAINT "contact_attribution_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "crm"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."contact_attribution" ADD CONSTRAINT "contact_attribution_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."contact_attribution" ADD CONSTRAINT "contact_attribution_first_sale_source_id_sale_sources_id_fk" FOREIGN KEY ("first_sale_source_id") REFERENCES "crm"."sale_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."contact_attribution" ADD CONSTRAINT "contact_attribution_last_sale_source_id_sale_sources_id_fk" FOREIGN KEY ("last_sale_source_id") REFERENCES "crm"."sale_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."inbound_sale_events" ADD CONSTRAINT "inbound_sale_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."inbound_sale_events" ADD CONSTRAINT "inbound_sale_events_sale_source_id_sale_sources_id_fk" FOREIGN KEY ("sale_source_id") REFERENCES "crm"."sale_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."inbound_sale_events" ADD CONSTRAINT "inbound_sale_events_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "crm"."sales"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."inbound_sale_events" ADD CONSTRAINT "inbound_sale_events_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "crm"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."sale_sources" ADD CONSTRAINT "sale_sources_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."sale_sources" ADD CONSTRAINT "sale_sources_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_attribution_company_idx" ON "crm"."contact_attribution" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "inbound_sale_events_source_seq_idx" ON "crm"."inbound_sale_events" USING btree ("sale_source_id","seq");--> statement-breakpoint
CREATE INDEX "inbound_sale_events_company_status_idx" ON "crm"."inbound_sale_events" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "sale_sources_token_uq" ON "crm"."sale_sources" USING btree ("token");--> statement-breakpoint
CREATE INDEX "sale_sources_company_idx" ON "crm"."sale_sources" USING btree ("company_id","created_at");