CREATE TYPE "crm"."flow_run_status" AS ENUM('running', 'waiting', 'paused', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "crm"."flow_status" AS ENUM('draft', 'active', 'paused', 'archived');--> statement-breakpoint
CREATE TABLE "crm"."flow_distributor_counters" (
	"company_id" uuid NOT NULL,
	"flow_id" uuid NOT NULL,
	"node_key" text NOT NULL,
	"output_key" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flow_distributor_counters_pk" PRIMARY KEY("company_id","flow_id","node_key","output_key")
);
--> statement-breakpoint
CREATE TABLE "crm"."flow_edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"flow_id" uuid NOT NULL,
	"key" text NOT NULL,
	"from_node_id" uuid NOT NULL,
	"handle" text NOT NULL,
	"to_node_id" uuid NOT NULL,
	"sort_index" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."flow_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT 'blue' NOT NULL,
	"parent_folder_id" uuid,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flow_folders_color_check" CHECK ("crm"."flow_folders"."color" in ('blue', 'green', 'purple', 'orange', 'red', 'yellow', 'gray')),
	CONSTRAINT "flow_folders_not_self_parent" CHECK ("crm"."flow_folders"."parent_folder_id" is null or "crm"."flow_folders"."parent_folder_id" <> "crm"."flow_folders"."id")
);
--> statement-breakpoint
CREATE TABLE "crm"."flow_node_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"key" text NOT NULL,
	"type" text NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sort_index" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."flow_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"flow_id" uuid NOT NULL,
	"key" text NOT NULL,
	"type" text NOT NULL,
	"original_type" text,
	"name" text NOT NULL,
	"description" text,
	"position_x" double precision NOT NULL,
	"position_y" double precision NOT NULL,
	"sort_index" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."flow_run_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"node_key" text NOT NULL,
	"action_key" text,
	"status" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."flow_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"flow_id" uuid NOT NULL,
	"version_id" uuid,
	"version" integer,
	"contact_id" uuid NOT NULL,
	"chat_id" uuid,
	"status" "crm"."flow_run_status" DEFAULT 'running' NOT NULL,
	"current_node_key" text,
	"seq" integer DEFAULT 0 NOT NULL,
	"vars" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"wait" jsonb,
	"trigger" jsonb,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."flow_share_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"flow_id" uuid NOT NULL,
	"code" text NOT NULL,
	"created_by_user_id" uuid,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."flow_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"flow_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"published_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flow_versions_version_positive" CHECK ("crm"."flow_versions"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "crm"."flows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"folder_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"status" "crm"."flow_status" DEFAULT 'active' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"entry_key" text DEFAULT 'start' NOT NULL,
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"published_version" integer,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crm"."flow_distributor_counters" ADD CONSTRAINT "flow_distributor_counters_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."flow_distributor_counters" ADD CONSTRAINT "flow_distributor_counters_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "crm"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."flow_edges" ADD CONSTRAINT "flow_edges_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."flow_edges" ADD CONSTRAINT "flow_edges_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "crm"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."flow_edges" ADD CONSTRAINT "flow_edges_from_node_id_flow_nodes_id_fk" FOREIGN KEY ("from_node_id") REFERENCES "crm"."flow_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."flow_edges" ADD CONSTRAINT "flow_edges_to_node_id_flow_nodes_id_fk" FOREIGN KEY ("to_node_id") REFERENCES "crm"."flow_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."flow_folders" ADD CONSTRAINT "flow_folders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."flow_folders" ADD CONSTRAINT "flow_folders_parent_folder_id_flow_folders_id_fk" FOREIGN KEY ("parent_folder_id") REFERENCES "crm"."flow_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."flow_node_actions" ADD CONSTRAINT "flow_node_actions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."flow_node_actions" ADD CONSTRAINT "flow_node_actions_node_id_flow_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "crm"."flow_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."flow_nodes" ADD CONSTRAINT "flow_nodes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."flow_nodes" ADD CONSTRAINT "flow_nodes_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "crm"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."flow_run_steps" ADD CONSTRAINT "flow_run_steps_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."flow_run_steps" ADD CONSTRAINT "flow_run_steps_run_id_flow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "crm"."flow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."flow_runs" ADD CONSTRAINT "flow_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."flow_runs" ADD CONSTRAINT "flow_runs_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "crm"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."flow_runs" ADD CONSTRAINT "flow_runs_version_id_flow_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "crm"."flow_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."flow_runs" ADD CONSTRAINT "flow_runs_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "crm"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."flow_share_codes" ADD CONSTRAINT "flow_share_codes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."flow_share_codes" ADD CONSTRAINT "flow_share_codes_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "crm"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."flow_share_codes" ADD CONSTRAINT "flow_share_codes_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."flow_versions" ADD CONSTRAINT "flow_versions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."flow_versions" ADD CONSTRAINT "flow_versions_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "crm"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."flows" ADD CONSTRAINT "flows_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."flows" ADD CONSTRAINT "flows_folder_id_flow_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "crm"."flow_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."flows" ADD CONSTRAINT "flows_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "flow_edges_from_handle_uq" ON "crm"."flow_edges" USING btree ("from_node_id","handle");--> statement-breakpoint
CREATE UNIQUE INDEX "flow_edges_flow_key_uq" ON "crm"."flow_edges" USING btree ("flow_id","key");--> statement-breakpoint
CREATE INDEX "flow_edges_company_flow_idx" ON "crm"."flow_edges" USING btree ("company_id","flow_id");--> statement-breakpoint
CREATE INDEX "flow_folders_company_parent_idx" ON "crm"."flow_folders" USING btree ("company_id","parent_folder_id");--> statement-breakpoint
CREATE UNIQUE INDEX "flow_node_actions_node_key_uq" ON "crm"."flow_node_actions" USING btree ("node_id","key");--> statement-breakpoint
CREATE INDEX "flow_node_actions_company_node_idx" ON "crm"."flow_node_actions" USING btree ("company_id","node_id","order");--> statement-breakpoint
CREATE UNIQUE INDEX "flow_nodes_flow_key_uq" ON "crm"."flow_nodes" USING btree ("flow_id","key");--> statement-breakpoint
CREATE INDEX "flow_nodes_company_flow_idx" ON "crm"."flow_nodes" USING btree ("company_id","flow_id");--> statement-breakpoint
CREATE UNIQUE INDEX "flow_run_steps_idempotency_key_uq" ON "crm"."flow_run_steps" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "flow_run_steps_company_run_idx" ON "crm"."flow_run_steps" USING btree ("company_id","run_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "flow_runs_active_contact_uq" ON "crm"."flow_runs" USING btree ("company_id","contact_id") WHERE "crm"."flow_runs"."status" in ('running', 'waiting');--> statement-breakpoint
CREATE INDEX "flow_runs_company_flow_status_idx" ON "crm"."flow_runs" USING btree ("company_id","flow_id","status");--> statement-breakpoint
CREATE INDEX "flow_runs_company_contact_idx" ON "crm"."flow_runs" USING btree ("company_id","contact_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "flow_share_codes_code_uq" ON "crm"."flow_share_codes" USING btree ("code");--> statement-breakpoint
CREATE INDEX "flow_share_codes_company_flow_idx" ON "crm"."flow_share_codes" USING btree ("company_id","flow_id");--> statement-breakpoint
CREATE UNIQUE INDEX "flow_versions_flow_version_uq" ON "crm"."flow_versions" USING btree ("flow_id","version");--> statement-breakpoint
CREATE INDEX "flow_versions_company_flow_idx" ON "crm"."flow_versions" USING btree ("company_id","flow_id");--> statement-breakpoint
CREATE INDEX "flows_company_folder_idx" ON "crm"."flows" USING btree ("company_id","folder_id","position");--> statement-breakpoint
CREATE INDEX "flows_company_status_idx" ON "crm"."flows" USING btree ("company_id","status");--> statement-breakpoint
-- Versão publicada é imutável (T19 AC-04): qualquer UPDATE é recusado; DELETE só em cascata ao apagar o fluxo.
CREATE FUNCTION "crm"."flow_versions_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'flow_versions é imutável' USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "flow_versions_immutable" BEFORE UPDATE ON "crm"."flow_versions" FOR EACH ROW EXECUTE FUNCTION "crm"."flow_versions_immutable"();
