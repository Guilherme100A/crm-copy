CREATE TABLE "crm"."capi_event_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"pixel_config_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"event_name" text NOT NULL,
	"action_source" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"source" text NOT NULL,
	"source_id" text,
	"response" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."pixel_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"platform" text DEFAULT 'facebook' NOT NULL,
	"pixel_id" text NOT NULL,
	"access_token_enc" text NOT NULL,
	"auto_send_sales" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pixel_configs_pixel_id_ck" CHECK ("crm"."pixel_configs"."pixel_id" ~ '^[0-9]+$'),
	CONSTRAINT "pixel_configs_name_ck" CHECK (char_length("crm"."pixel_configs"."name") between 2 and 255)
);
--> statement-breakpoint
ALTER TABLE "crm"."capi_event_log" ADD CONSTRAINT "capi_event_log_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."capi_event_log" ADD CONSTRAINT "capi_event_log_pixel_config_id_pixel_configs_id_fk" FOREIGN KEY ("pixel_config_id") REFERENCES "crm"."pixel_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."pixel_configs" ADD CONSTRAINT "pixel_configs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "capi_event_log_pixel_event_uq" ON "crm"."capi_event_log" USING btree ("pixel_config_id","event_id");--> statement-breakpoint
CREATE INDEX "capi_event_log_company_idx" ON "crm"."capi_event_log" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "pixel_configs_company_idx" ON "crm"."pixel_configs" USING btree ("company_id","created_at");