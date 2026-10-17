CREATE TABLE "crm"."sale_utmify_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"sale_status" text NOT NULL,
	"utmify_integration_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sale_utmify_events_sale_status_check" CHECK ("crm"."sale_utmify_events"."sale_status" in ('approved', 'refunded')),
	CONSTRAINT "sale_utmify_events_status_check" CHECK ("crm"."sale_utmify_events"."status" in ('pending', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "crm"."utmify_integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"company_name" text NOT NULL,
	"token_enc" text,
	"token_hint" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "utmify_integrations_company_name_len" CHECK (char_length("crm"."utmify_integrations"."company_name") between 2 and 120)
);
--> statement-breakpoint
ALTER TABLE "crm"."sale_utmify_events" ADD CONSTRAINT "sale_utmify_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."sale_utmify_events" ADD CONSTRAINT "sale_utmify_events_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "crm"."sales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."sale_utmify_events" ADD CONSTRAINT "sale_utmify_events_utmify_integration_id_utmify_integrations_id_fk" FOREIGN KEY ("utmify_integration_id") REFERENCES "crm"."utmify_integrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."utmify_integrations" ADD CONSTRAINT "utmify_integrations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."utmify_integrations" ADD CONSTRAINT "utmify_integrations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sale_utmify_events_sale_status_uq" ON "crm"."sale_utmify_events" USING btree ("sale_id","sale_status");--> statement-breakpoint
CREATE INDEX "sale_utmify_events_company_status_idx" ON "crm"."sale_utmify_events" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "utmify_integrations_company_idx" ON "crm"."utmify_integrations" USING btree ("company_id","created_at");