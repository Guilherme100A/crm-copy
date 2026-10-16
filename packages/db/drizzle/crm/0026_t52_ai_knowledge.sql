CREATE TABLE "crm"."ai_knowledge_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"content" text NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('portuguese', content)) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."ai_knowledge_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"slot" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"title" text,
	"url" text,
	"body" text,
	"filename" text,
	"content_type" text,
	"file_data" "bytea",
	"flow_id" uuid,
	"items" jsonb,
	"pages_count" integer,
	"questions_count" integer,
	"chunks_count" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"error_detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crm"."ai_knowledge_chunks" ADD CONSTRAINT "ai_knowledge_chunks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."ai_knowledge_chunks" ADD CONSTRAINT "ai_knowledge_chunks_source_id_ai_knowledge_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "crm"."ai_knowledge_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."ai_knowledge_sources" ADD CONSTRAINT "ai_knowledge_sources_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."ai_knowledge_sources" ADD CONSTRAINT "ai_knowledge_sources_agent_id_ai_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "crm"."ai_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_knowledge_chunks_company_agent_idx" ON "crm"."ai_knowledge_chunks" USING btree ("company_id","agent_id");--> statement-breakpoint
CREATE INDEX "ai_knowledge_chunks_source_idx" ON "crm"."ai_knowledge_chunks" USING btree ("source_id","position");--> statement-breakpoint
CREATE INDEX "ai_knowledge_chunks_tsv_idx" ON "crm"."ai_knowledge_chunks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "ai_knowledge_sources_company_agent_idx" ON "crm"."ai_knowledge_sources" USING btree ("company_id","agent_id","slot");