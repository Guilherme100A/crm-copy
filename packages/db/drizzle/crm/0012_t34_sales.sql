CREATE TABLE "crm"."dashboard_filter_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"connection_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"product_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"ad_account_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."expense_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'fixed' NOT NULL,
	"amount_cents" bigint,
	"currency" text,
	"percent" numeric(7, 4),
	"percent_base" text,
	"period" text DEFAULT 'month' NOT NULL,
	"active_from" date,
	"active_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_rules_kind_ck" CHECK (("crm"."expense_rules"."kind" = 'fixed' and "crm"."expense_rules"."amount_cents" is not null) or ("crm"."expense_rules"."kind" = 'percent' and "crm"."expense_rules"."percent" is not null and "crm"."expense_rules"."percent_base" is not null))
);
--> statement-breakpoint
CREATE TABLE "crm"."products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"currency" text DEFAULT 'BRL' NOT NULL,
	"price_min_cents" bigint NOT NULL,
	"price_max_cents" bigint NOT NULL,
	"price_fallback_cents" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_prices_ck" CHECK ("crm"."products"."price_min_cents" >= 0 and "crm"."products"."price_max_cents" >= "crm"."products"."price_min_cents" and "crm"."products"."price_fallback_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "crm"."sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"contact_id" uuid,
	"connection_id" uuid,
	"product_id" uuid,
	"amount_cents" bigint NOT NULL,
	"currency" text DEFAULT 'BRL' NOT NULL,
	"sold_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"source_id" text,
	"ctwa_clid" text,
	"external_id" text,
	"status" text DEFAULT 'approved' NOT NULL,
	"instance_name" text,
	"instance_number" text,
	"lead_number" text,
	"customer_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_source_ck" CHECK ("crm"."sales"."source" in ('manual', 'flow', 'webhook')),
	CONSTRAINT "sales_status_ck" CHECK ("crm"."sales"."status" in ('approved', 'refunded', 'chargeback', 'pending')),
	CONSTRAINT "sales_amount_ck" CHECK ("crm"."sales"."amount_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "crm"."dashboard_filter_groups" ADD CONSTRAINT "dashboard_filter_groups_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."expense_rules" ADD CONSTRAINT "expense_rules_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."products" ADD CONSTRAINT "products_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."sales" ADD CONSTRAINT "sales_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."sales" ADD CONSTRAINT "sales_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "crm"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."sales" ADD CONSTRAINT "sales_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "crm"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dashboard_filter_groups_company_name_uq" ON "crm"."dashboard_filter_groups" USING btree ("company_id",lower(trim("name")));--> statement-breakpoint
CREATE INDEX "expense_rules_company_idx" ON "crm"."expense_rules" USING btree ("company_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "products_public_id_uq" ON "crm"."products" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "products_company_name_idx" ON "crm"."products" USING btree ("company_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_company_source_external_uq" ON "crm"."sales" USING btree ("company_id","source","external_id") WHERE "crm"."sales"."external_id" is not null;--> statement-breakpoint
CREATE INDEX "sales_company_sold_idx" ON "crm"."sales" USING btree ("company_id","sold_at");--> statement-breakpoint
CREATE INDEX "sales_company_product_idx" ON "crm"."sales" USING btree ("company_id","product_id");