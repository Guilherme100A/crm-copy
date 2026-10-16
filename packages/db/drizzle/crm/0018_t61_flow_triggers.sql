CREATE TABLE "crm"."connection_flow_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"welcome_flow_id" uuid,
	"default_response_flow_id" uuid,
	"default_response_delay_hours" integer DEFAULT 24 NOT NULL,
	"finished_conversation_flow_id" uuid,
	"finished_attendance_flow_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_flow_configs_delay_ck" CHECK ("crm"."connection_flow_configs"."default_response_delay_hours" between 1 and 168)
);
--> statement-breakpoint
CREATE TABLE "crm"."flow_trigger_events" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"flow_id" uuid,
	"run_id" uuid,
	"keyword_trigger_id" uuid,
	"out_of_hours" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."keyword_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"config_id" uuid NOT NULL,
	"flow_id" uuid NOT NULL,
	"rule_type" text DEFAULT 'any' NOT NULL,
	"conditions" jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "keyword_triggers_rule_ck" CHECK ("crm"."keyword_triggers"."rule_type" in ('any', 'all'))
);
--> statement-breakpoint
CREATE TABLE "crm"."out_of_hours_actions" (
	"company_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"last_action_at" timestamp with time zone NOT NULL,
	CONSTRAINT "out_of_hours_actions_chat_id_pk" PRIMARY KEY("chat_id")
);
--> statement-breakpoint
ALTER TABLE "crm"."connection_flow_configs" ADD CONSTRAINT "connection_flow_configs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."connection_flow_configs" ADD CONSTRAINT "connection_flow_configs_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "crm"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."connection_flow_configs" ADD CONSTRAINT "connection_flow_configs_welcome_flow_id_flows_id_fk" FOREIGN KEY ("welcome_flow_id") REFERENCES "crm"."flows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."connection_flow_configs" ADD CONSTRAINT "connection_flow_configs_default_response_flow_id_flows_id_fk" FOREIGN KEY ("default_response_flow_id") REFERENCES "crm"."flows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."connection_flow_configs" ADD CONSTRAINT "connection_flow_configs_finished_conversation_flow_id_flows_id_fk" FOREIGN KEY ("finished_conversation_flow_id") REFERENCES "crm"."flows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."connection_flow_configs" ADD CONSTRAINT "connection_flow_configs_finished_attendance_flow_id_flows_id_fk" FOREIGN KEY ("finished_attendance_flow_id") REFERENCES "crm"."flows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."flow_trigger_events" ADD CONSTRAINT "flow_trigger_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."flow_trigger_events" ADD CONSTRAINT "flow_trigger_events_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "crm"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."flow_trigger_events" ADD CONSTRAINT "flow_trigger_events_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "crm"."flows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."flow_trigger_events" ADD CONSTRAINT "flow_trigger_events_run_id_flow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "crm"."flow_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."flow_trigger_events" ADD CONSTRAINT "flow_trigger_events_keyword_trigger_id_keyword_triggers_id_fk" FOREIGN KEY ("keyword_trigger_id") REFERENCES "crm"."keyword_triggers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."keyword_triggers" ADD CONSTRAINT "keyword_triggers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."keyword_triggers" ADD CONSTRAINT "keyword_triggers_config_id_connection_flow_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "crm"."connection_flow_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."keyword_triggers" ADD CONSTRAINT "keyword_triggers_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "crm"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."out_of_hours_actions" ADD CONSTRAINT "out_of_hours_actions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."out_of_hours_actions" ADD CONSTRAINT "out_of_hours_actions_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "crm"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connection_flow_configs_connection_uq" ON "crm"."connection_flow_configs" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "connection_flow_configs_company_idx" ON "crm"."connection_flow_configs" USING btree ("company_id","connection_id");--> statement-breakpoint
CREATE INDEX "flow_trigger_events_company_chat_idx" ON "crm"."flow_trigger_events" USING btree ("company_id","chat_id","created_at");--> statement-breakpoint
CREATE INDEX "keyword_triggers_company_config_idx" ON "crm"."keyword_triggers" USING btree ("company_id","config_id","position");--> statement-breakpoint
CREATE INDEX "keyword_triggers_company_flow_idx" ON "crm"."keyword_triggers" USING btree ("company_id","flow_id");--> statement-breakpoint
CREATE INDEX "out_of_hours_actions_company_idx" ON "crm"."out_of_hours_actions" USING btree ("company_id","chat_id");