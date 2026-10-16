CREATE TABLE "crm"."inbound_webhook_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"company_id" uuid NOT NULL,
	"webhook_id" uuid NOT NULL,
	"processing_status" text DEFAULT 'pending' NOT NULL,
	"raw_body" text DEFAULT '' NOT NULL,
	"raw_body_truncated" boolean DEFAULT false NOT NULL,
	"body_size" integer DEFAULT 0 NOT NULL,
	"body_hash" text DEFAULT '' NOT NULL,
	"content_type" text,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"reason" text,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbound_webhook_requests_status_check" CHECK ("crm"."inbound_webhook_requests"."processing_status" in ('pending', 'processed', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "crm"."inbound_webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"connection_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"public_token" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"month_period" text,
	"month_count" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbound_webhooks_name_len" CHECK (char_length("crm"."inbound_webhooks"."name") between 1 and 120),
	CONSTRAINT "inbound_webhooks_token_len" CHECK (char_length("crm"."inbound_webhooks"."public_token") >= 43)
);
--> statement-breakpoint
ALTER TABLE "crm"."inbound_webhook_requests" ADD CONSTRAINT "inbound_webhook_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."inbound_webhook_requests" ADD CONSTRAINT "inbound_webhook_requests_webhook_id_inbound_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "crm"."inbound_webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."inbound_webhooks" ADD CONSTRAINT "inbound_webhooks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."inbound_webhooks" ADD CONSTRAINT "inbound_webhooks_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "crm"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."inbound_webhooks" ADD CONSTRAINT "inbound_webhooks_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbound_webhook_requests_webhook_seq_idx" ON "crm"."inbound_webhook_requests" USING btree ("webhook_id","seq");--> statement-breakpoint
CREATE INDEX "inbound_webhook_requests_webhook_hash_idx" ON "crm"."inbound_webhook_requests" USING btree ("webhook_id","body_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_webhooks_public_token_uq" ON "crm"."inbound_webhooks" USING btree ("public_token");--> statement-breakpoint
CREATE INDEX "inbound_webhooks_company_idx" ON "crm"."inbound_webhooks" USING btree ("company_id","created_at");