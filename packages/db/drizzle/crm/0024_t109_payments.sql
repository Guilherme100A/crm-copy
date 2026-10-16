CREATE TABLE "crm"."payment_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"integration_id" uuid,
	"gateway" text NOT NULL,
	"flow_run_id" uuid,
	"node_id" uuid,
	"contact_id" uuid,
	"amount_cents" bigint,
	"currency" text NOT NULL,
	"method" text NOT NULL,
	"transaction_id" text NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"paid_amount_cents" bigint,
	"paid_at" timestamp with time zone,
	"listener_until" timestamp with time zone,
	"instructions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_charges_status_check" CHECK ("crm"."payment_charges"."status" in ('created', 'approved', 'failed', 'expired', 'refunded')),
	CONSTRAINT "payment_charges_amount_ck" CHECK ("crm"."payment_charges"."amount_cents" is null or "crm"."payment_charges"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "crm"."payment_integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"label" text NOT NULL,
	"gateway" text NOT NULL,
	"client_id" text DEFAULT '' NOT NULL,
	"client_secret_enc" text,
	"secret_hint" text,
	"webhook_secret_enc" text NOT NULL,
	"zenith_oauth" boolean DEFAULT false NOT NULL,
	"extra_enc" text,
	"last_tested_at" timestamp with time zone,
	"last_test_ok" boolean,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_integrations_label_len" CHECK (char_length("crm"."payment_integrations"."label") between 2 and 120),
	CONSTRAINT "payment_integrations_gateway_check" CHECK ("crm"."payment_integrations"."gateway" in ('xpag', 'zenith'))
);
--> statement-breakpoint
ALTER TABLE "crm"."payment_charges" ADD CONSTRAINT "payment_charges_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."payment_charges" ADD CONSTRAINT "payment_charges_integration_id_payment_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "crm"."payment_integrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."payment_charges" ADD CONSTRAINT "payment_charges_flow_run_id_flow_runs_id_fk" FOREIGN KEY ("flow_run_id") REFERENCES "crm"."flow_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."payment_charges" ADD CONSTRAINT "payment_charges_node_id_flow_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "crm"."flow_nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."payment_charges" ADD CONSTRAINT "payment_charges_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "crm"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."payment_integrations" ADD CONSTRAINT "payment_integrations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."payment_integrations" ADD CONSTRAINT "payment_integrations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_charges_gateway_tx_uq" ON "crm"."payment_charges" USING btree ("gateway","transaction_id");--> statement-breakpoint
CREATE INDEX "payment_charges_company_status_idx" ON "crm"."payment_charges" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX "payment_charges_run_idx" ON "crm"."payment_charges" USING btree ("flow_run_id");--> statement-breakpoint
CREATE INDEX "payment_integrations_company_gateway_idx" ON "crm"."payment_integrations" USING btree ("company_id","gateway","created_at");