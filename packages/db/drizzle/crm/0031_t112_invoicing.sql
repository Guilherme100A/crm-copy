CREATE TABLE "crm"."invoice_integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text DEFAULT 'notasy' NOT NULL,
	"company_name" text NOT NULL,
	"token_enc" text,
	"token_hint" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_integrations_company_name_len" CHECK (char_length("crm"."invoice_integrations"."company_name") between 2 and 120),
	CONSTRAINT "invoice_integrations_provider_check" CHECK ("crm"."invoice_integrations"."provider" in ('notasy'))
);
--> statement-breakpoint
CREATE TABLE "crm"."sale_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"invoice_integration_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"last_error" text,
	"external_id" text,
	"number" text,
	"pdf_url" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"succeeded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sale_invoices_status_check" CHECK ("crm"."sale_invoices"."status" in ('pending', 'succeeded', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "crm"."invoice_integrations" ADD CONSTRAINT "invoice_integrations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."invoice_integrations" ADD CONSTRAINT "invoice_integrations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."sale_invoices" ADD CONSTRAINT "sale_invoices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."sale_invoices" ADD CONSTRAINT "sale_invoices_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "crm"."sales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."sale_invoices" ADD CONSTRAINT "sale_invoices_invoice_integration_id_invoice_integrations_id_fk" FOREIGN KEY ("invoice_integration_id") REFERENCES "crm"."invoice_integrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_integrations_company_idx" ON "crm"."invoice_integrations" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sale_invoices_sale_uq" ON "crm"."sale_invoices" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "sale_invoices_company_status_idx" ON "crm"."sale_invoices" USING btree ("company_id","status");