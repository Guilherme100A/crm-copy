CREATE TABLE "crm"."flow_copilot_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"client_message_id" text,
	"tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"credits" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flow_copilot_messages_role_ck" CHECK ("crm"."flow_copilot_messages"."role" in ('user', 'assistant'))
);
--> statement-breakpoint
CREATE TABLE "crm"."flow_copilot_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"flow_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"status_before_archive" text,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flow_copilot_sessions_status_ck" CHECK ("crm"."flow_copilot_sessions"."status" in ('active', 'paused_quota', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "crm"."flow_copilot_messages" ADD CONSTRAINT "flow_copilot_messages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."flow_copilot_messages" ADD CONSTRAINT "flow_copilot_messages_session_id_flow_copilot_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "crm"."flow_copilot_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."flow_copilot_sessions" ADD CONSTRAINT "flow_copilot_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."flow_copilot_sessions" ADD CONSTRAINT "flow_copilot_sessions_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "crm"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."flow_copilot_sessions" ADD CONSTRAINT "flow_copilot_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "crm"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "flow_copilot_messages_company_session_idx" ON "crm"."flow_copilot_messages" USING btree ("company_id","session_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "flow_copilot_messages_client_uq" ON "crm"."flow_copilot_messages" USING btree ("session_id","client_message_id") WHERE "crm"."flow_copilot_messages"."client_message_id" is not null;--> statement-breakpoint
CREATE INDEX "flow_copilot_sessions_company_flow_idx" ON "crm"."flow_copilot_sessions" USING btree ("company_id","flow_id","user_id","created_at");