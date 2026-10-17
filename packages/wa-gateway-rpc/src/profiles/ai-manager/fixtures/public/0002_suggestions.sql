CREATE TYPE "public"."suggestion_status" AS ENUM('pending_approval', 'approved', 'rejected', 'sent', 'failed');--> statement-breakpoint
CREATE TABLE "suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"inbound_message_id" uuid NOT NULL,
	"intent" text NOT NULL,
	"confidence" real NOT NULL,
	"model" text NOT NULL,
	"text" text NOT NULL,
	"status" "suggestion_status" DEFAULT 'pending_approval' NOT NULL,
	"sent_message_id" uuid,
	"error" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suggestions_confidence_check" CHECK ("suggestions"."confidence" >= 0 and "suggestions"."confidence" <= 1)
);
--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_inbound_message_id_messages_id_fk" FOREIGN KEY ("inbound_message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_sent_message_id_messages_id_fk" FOREIGN KEY ("sent_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "suggestions_session_status_idx" ON "suggestions" USING btree ("session_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "suggestions_inbound_message_unique" ON "suggestions" USING btree ("inbound_message_id");