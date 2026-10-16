CREATE TABLE "crm"."message_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"text" text,
	"quick_reply_id" uuid,
	"flow_id" uuid,
	"run_at" timestamp with time zone NOT NULL,
	"recurrence" text DEFAULT 'one_off' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"run_count" integer DEFAULT 0 NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_error" text,
	"last_message_id" uuid,
	"last_flow_run_id" uuid,
	"created_by_user_id" uuid,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_schedules_kind_check" CHECK ("crm"."message_schedules"."kind" in ('message', 'flow')),
	CONSTRAINT "message_schedules_recurrence_check" CHECK ("crm"."message_schedules"."recurrence" in ('one_off', 'daily', 'weekly', 'monthly')),
	CONSTRAINT "message_schedules_status_check" CHECK ("crm"."message_schedules"."status" in ('pending', 'sent', 'failed', 'cancelled')),
	CONSTRAINT "message_schedules_content_check" CHECK (("crm"."message_schedules"."kind" = 'message' and "crm"."message_schedules"."text" is not null) or ("crm"."message_schedules"."kind" = 'flow' and "crm"."message_schedules"."flow_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "crm"."message_schedules" ADD CONSTRAINT "message_schedules_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."message_schedules" ADD CONSTRAINT "message_schedules_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "crm"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."message_schedules" ADD CONSTRAINT "message_schedules_last_message_id_messages_id_fk" FOREIGN KEY ("last_message_id") REFERENCES "crm"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."message_schedules" ADD CONSTRAINT "message_schedules_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_schedules_company_chat_idx" ON "crm"."message_schedules" USING btree ("company_id","chat_id","run_at");--> statement-breakpoint
CREATE INDEX "message_schedules_company_status_idx" ON "crm"."message_schedules" USING btree ("company_id","status","run_at");