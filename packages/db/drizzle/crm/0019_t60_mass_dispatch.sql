CREATE TABLE "crm"."mass_dispatch_quota_bonuses" (
	"company_id" uuid NOT NULL,
	"period" text NOT NULL,
	"bonus" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mass_dispatch_quota_bonuses_pk" PRIMARY KEY("company_id","period")
);
--> statement-breakpoint
CREATE TABLE "crm"."mass_dispatch_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"dispatch_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"target_id" uuid,
	"variant" text DEFAULT 'a' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"skip_reason" text,
	"error" text,
	"scheduled_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"flow_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mass_dispatch_recipients_status_ck" CHECK ("crm"."mass_dispatch_recipients"."status" in ('pending', 'started', 'failed', 'cancelled', 'skipped')),
	CONSTRAINT "mass_dispatch_recipients_variant_ck" CHECK ("crm"."mass_dispatch_recipients"."variant" in ('a', 'b'))
);
--> statement-breakpoint
CREATE TABLE "crm"."mass_dispatch_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"per_connection_limit" integer DEFAULT 500 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mass_dispatch_settings_singleton_ck" CHECK ("crm"."mass_dispatch_settings"."id" = 1),
	CONSTRAINT "mass_dispatch_settings_limit_ck" CHECK ("crm"."mass_dispatch_settings"."per_connection_limit" >= 0)
);
--> statement-breakpoint
CREATE TABLE "crm"."mass_dispatch_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"dispatch_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"flow_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."mass_dispatches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text,
	"status" text DEFAULT 'preparing' NOT NULL,
	"flow_b_id" uuid,
	"weekdays" jsonb NOT NULL,
	"window_start" text NOT NULL,
	"window_end" text NOT NULL,
	"time_zone" text NOT NULL,
	"interval_min_seconds" integer NOT NULL,
	"interval_max_seconds" integer NOT NULL,
	"daily_limit" integer,
	"starts_scheduling_at" timestamp with time zone NOT NULL,
	"quota_period" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"preparation_progress" jsonb DEFAULT '{"phase":"queued","scheduled_count":0,"target_count":0}'::jsonb NOT NULL,
	"preparation_error" text,
	"created_by" uuid,
	"first_sent_at" timestamp with time zone,
	"last_sent_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mass_dispatches_status_ck" CHECK ("crm"."mass_dispatches"."status" in ('preparing', 'scheduled', 'running', 'paused', 'completed', 'cancelled', 'failed')),
	CONSTRAINT "mass_dispatches_interval_ck" CHECK ("crm"."mass_dispatches"."interval_min_seconds" between 0 and 120 and "crm"."mass_dispatches"."interval_max_seconds" between "crm"."mass_dispatches"."interval_min_seconds" and 120)
);
--> statement-breakpoint
ALTER TABLE "crm"."mass_dispatch_quota_bonuses" ADD CONSTRAINT "mass_dispatch_quota_bonuses_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."mass_dispatch_recipients" ADD CONSTRAINT "mass_dispatch_recipients_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."mass_dispatch_recipients" ADD CONSTRAINT "mass_dispatch_recipients_dispatch_id_mass_dispatches_id_fk" FOREIGN KEY ("dispatch_id") REFERENCES "crm"."mass_dispatches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."mass_dispatch_recipients" ADD CONSTRAINT "mass_dispatch_recipients_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "crm"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."mass_dispatch_recipients" ADD CONSTRAINT "mass_dispatch_recipients_target_id_mass_dispatch_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "crm"."mass_dispatch_targets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."mass_dispatch_targets" ADD CONSTRAINT "mass_dispatch_targets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."mass_dispatch_targets" ADD CONSTRAINT "mass_dispatch_targets_dispatch_id_mass_dispatches_id_fk" FOREIGN KEY ("dispatch_id") REFERENCES "crm"."mass_dispatches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."mass_dispatch_targets" ADD CONSTRAINT "mass_dispatch_targets_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "crm"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."mass_dispatch_targets" ADD CONSTRAINT "mass_dispatch_targets_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "crm"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."mass_dispatches" ADD CONSTRAINT "mass_dispatches_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."mass_dispatches" ADD CONSTRAINT "mass_dispatches_flow_b_id_flows_id_fk" FOREIGN KEY ("flow_b_id") REFERENCES "crm"."flows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."mass_dispatches" ADD CONSTRAINT "mass_dispatches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mass_dispatch_recipients_contact_uq" ON "crm"."mass_dispatch_recipients" USING btree ("dispatch_id","contact_id");--> statement-breakpoint
CREATE INDEX "mass_dispatch_recipients_dispatch_status_idx" ON "crm"."mass_dispatch_recipients" USING btree ("dispatch_id","status");--> statement-breakpoint
CREATE INDEX "mass_dispatch_recipients_company_idx" ON "crm"."mass_dispatch_recipients" USING btree ("company_id","dispatch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mass_dispatch_targets_position_uq" ON "crm"."mass_dispatch_targets" USING btree ("dispatch_id","position");--> statement-breakpoint
CREATE INDEX "mass_dispatch_targets_company_idx" ON "crm"."mass_dispatch_targets" USING btree ("company_id","dispatch_id");--> statement-breakpoint
CREATE INDEX "mass_dispatches_company_created_idx" ON "crm"."mass_dispatches" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "mass_dispatches_company_period_idx" ON "crm"."mass_dispatches" USING btree ("company_id","quota_period");