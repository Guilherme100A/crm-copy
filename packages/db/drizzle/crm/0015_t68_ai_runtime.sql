CREATE TABLE "crm"."ai_conversation_state" (
	"chat_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"paused_reason" text,
	"active_since" timestamp with time zone DEFAULT now() NOT NULL,
	"pending" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"buffer_gen" integer DEFAULT 0 NOT NULL,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"collected" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"audio_count" integer DEFAULT 0 NOT NULL,
	"stall_count" integer DEFAULT 0 NOT NULL,
	"replies_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crm"."ai_conversation_state" ADD CONSTRAINT "ai_conversation_state_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "crm"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."ai_conversation_state" ADD CONSTRAINT "ai_conversation_state_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."ai_conversation_state" ADD CONSTRAINT "ai_conversation_state_agent_id_ai_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "crm"."ai_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_conversation_state_company_agent_idx" ON "crm"."ai_conversation_state" USING btree ("company_id","agent_id");