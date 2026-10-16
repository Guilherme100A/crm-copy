CREATE TABLE "crm"."chat_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor_user_id" uuid,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."chat_labels" (
	"company_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_labels_pk" PRIMARY KEY("chat_id","label_id")
);
--> statement-breakpoint
CREATE TABLE "crm"."chat_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"author_user_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."chats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"assigned_user_id" uuid,
	"department_id" uuid,
	"ai_agent_id" uuid,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"last_message_preview" text,
	"last_message_at" timestamp with time zone,
	"last_inbound_at" timestamp with time zone,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_human_reply_at" timestamp with time zone,
	"first_human_reply_by" uuid,
	"resolved_at" timestamp with time zone,
	"blocked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."message_reactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_user_id" uuid,
	"emoji" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"sender_type" text NOT NULL,
	"sender_user_id" uuid,
	"type" text NOT NULL,
	"wa_type" text,
	"body" text,
	"media" jsonb,
	"quoted_wa_message_id" text,
	"status" text NOT NULL,
	"error" text,
	"wa_message_id" text,
	"pipeline_message_id" text,
	"wa_key" jsonb,
	"historical" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"wa_timestamp" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crm"."chat_events" ADD CONSTRAINT "chat_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."chat_events" ADD CONSTRAINT "chat_events_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "crm"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."chat_events" ADD CONSTRAINT "chat_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."chat_labels" ADD CONSTRAINT "chat_labels_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."chat_labels" ADD CONSTRAINT "chat_labels_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "crm"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."chat_labels" ADD CONSTRAINT "chat_labels_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "crm"."labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."chat_notes" ADD CONSTRAINT "chat_notes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."chat_notes" ADD CONSTRAINT "chat_notes_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "crm"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."chat_notes" ADD CONSTRAINT "chat_notes_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."chats" ADD CONSTRAINT "chats_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."chats" ADD CONSTRAINT "chats_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "crm"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."chats" ADD CONSTRAINT "chats_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."chats" ADD CONSTRAINT "chats_first_human_reply_by_users_id_fk" FOREIGN KEY ("first_human_reply_by") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."message_reactions" ADD CONSTRAINT "message_reactions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."message_reactions" ADD CONSTRAINT "message_reactions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "crm"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."message_reactions" ADD CONSTRAINT "message_reactions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "crm"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."messages" ADD CONSTRAINT "messages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."messages" ADD CONSTRAINT "messages_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "crm"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."messages" ADD CONSTRAINT "messages_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_events_chat_idx" ON "crm"."chat_events" USING btree ("chat_id","created_at");--> statement-breakpoint
CREATE INDEX "chat_labels_company_label_idx" ON "crm"."chat_labels" USING btree ("company_id","label_id");--> statement-breakpoint
CREATE INDEX "chat_notes_chat_idx" ON "crm"."chat_notes" USING btree ("chat_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chats_company_connection_contact_uq" ON "crm"."chats" USING btree ("company_id","connection_id","contact_id");--> statement-breakpoint
CREATE INDEX "chats_company_status_last_idx" ON "crm"."chats" USING btree ("company_id","status","last_message_at");--> statement-breakpoint
CREATE INDEX "chats_company_contact_idx" ON "crm"."chats" USING btree ("company_id","contact_id");--> statement-breakpoint
CREATE INDEX "message_reactions_message_idx" ON "crm"."message_reactions" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_company_wa_id_uq" ON "crm"."messages" USING btree ("company_id","wa_message_id") WHERE "crm"."messages"."wa_message_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_company_pipeline_id_uq" ON "crm"."messages" USING btree ("company_id","pipeline_message_id") WHERE "crm"."messages"."pipeline_message_id" is not null;--> statement-breakpoint
CREATE INDEX "messages_chat_created_idx" ON "crm"."messages" USING btree ("chat_id","created_at");