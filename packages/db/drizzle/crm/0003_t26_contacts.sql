CREATE TABLE "crm"."contact_labels" (
	"company_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_labels_pk" PRIMARY KEY("contact_id","label_id")
);
--> statement-breakpoint
CREATE TABLE "crm"."contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"phone_e164" text,
	"wa_lid" text,
	"email" text,
	"state" text,
	"city" text,
	"zip" text,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"consent" boolean DEFAULT false NOT NULL,
	"consent_source" text,
	"opt_out" boolean DEFAULT false NOT NULL,
	"origin" text DEFAULT 'manual' NOT NULL,
	"ctwa_clid" text,
	"source_id" text,
	"source_url" text,
	"ad_media_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."custom_field_defs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"description" text,
	"example_value" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crm"."contact_labels" ADD CONSTRAINT "contact_labels_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."contact_labels" ADD CONSTRAINT "contact_labels_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "crm"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."contact_labels" ADD CONSTRAINT "contact_labels_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "crm"."labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."contacts" ADD CONSTRAINT "contacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."custom_field_defs" ADD CONSTRAINT "custom_field_defs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."labels" ADD CONSTRAINT "labels_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_labels_company_label_idx" ON "crm"."contact_labels" USING btree ("company_id","label_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_company_phone_uq" ON "crm"."contacts" USING btree ("company_id","phone_e164") WHERE "crm"."contacts"."phone_e164" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_company_lid_uq" ON "crm"."contacts" USING btree ("company_id","wa_lid") WHERE "crm"."contacts"."wa_lid" is not null;--> statement-breakpoint
CREATE INDEX "contacts_company_created_idx" ON "crm"."contacts" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_field_defs_company_key_uq" ON "crm"."custom_field_defs" USING btree ("company_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "labels_company_name_uq" ON "crm"."labels" USING btree ("company_id",lower("name"));