CREATE TABLE "crm"."background_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"progress" jsonb DEFAULT '{"processed":0,"total":null,"percent":null}'::jsonb NOT NULL,
	"counters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"row_count" integer,
	"error" text,
	"file_key" text,
	"file_name" text,
	"file_size" bigint,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "background_jobs_status_ck" CHECK ("crm"."background_jobs"."status" in ('queued', 'processing', 'completed', 'failed')),
	CONSTRAINT "background_jobs_type_ck" CHECK ("crm"."background_jobs"."type" in ('export', 'import'))
);
--> statement-breakpoint
ALTER TABLE "crm"."background_jobs" ADD CONSTRAINT "background_jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."background_jobs" ADD CONSTRAINT "background_jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "background_jobs_company_kind_idx" ON "crm"."background_jobs" USING btree ("company_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "background_jobs_company_created_idx" ON "crm"."background_jobs" USING btree ("company_id","created_at");