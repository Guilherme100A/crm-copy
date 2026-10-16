CREATE TABLE "crm"."global_variables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"type" text DEFAULT 'text' NOT NULL,
	"value" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "global_variables_name_check" CHECK ("crm"."global_variables"."name" ~ '^g_[A-Za-z0-9_]+$'),
	CONSTRAINT "global_variables_type_check" CHECK ("crm"."global_variables"."type" in ('text', 'number'))
);
--> statement-breakpoint
CREATE TABLE "crm"."message_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"header" jsonb DEFAULT '{"type":"none"}'::jsonb NOT NULL,
	"body" text NOT NULL,
	"footer" text,
	"buttons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."quick_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"shortcut" text NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."quick_reply_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"quick_reply_id" uuid NOT NULL,
	"type" text NOT NULL,
	"order" integer NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quick_reply_actions_type_check" CHECK ("crm"."quick_reply_actions"."type" in ('send_message', 'send_multi_media', 'send_sticker', 'send_contact'))
);
--> statement-breakpoint
CREATE TABLE "crm"."sticker_favorites" (
	"company_id" uuid NOT NULL,
	"sticker_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sticker_favorites_pk" PRIMARY KEY("sticker_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "crm"."stickers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"media_id" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crm"."global_variables" ADD CONSTRAINT "global_variables_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."message_templates" ADD CONSTRAINT "message_templates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."message_templates" ADD CONSTRAINT "message_templates_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."quick_replies" ADD CONSTRAINT "quick_replies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."quick_replies" ADD CONSTRAINT "quick_replies_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."quick_reply_actions" ADD CONSTRAINT "quick_reply_actions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."quick_reply_actions" ADD CONSTRAINT "quick_reply_actions_quick_reply_id_quick_replies_id_fk" FOREIGN KEY ("quick_reply_id") REFERENCES "crm"."quick_replies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."sticker_favorites" ADD CONSTRAINT "sticker_favorites_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."sticker_favorites" ADD CONSTRAINT "sticker_favorites_sticker_id_stickers_id_fk" FOREIGN KEY ("sticker_id") REFERENCES "crm"."stickers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."sticker_favorites" ADD CONSTRAINT "sticker_favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "crm"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."stickers" ADD CONSTRAINT "stickers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."stickers" ADD CONSTRAINT "stickers_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "global_variables_company_name_uq" ON "crm"."global_variables" USING btree ("company_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "message_templates_company_name_uq" ON "crm"."message_templates" USING btree ("company_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "quick_replies_company_shortcut_uq" ON "crm"."quick_replies" USING btree ("company_id","shortcut");--> statement-breakpoint
CREATE INDEX "quick_reply_actions_company_reply_idx" ON "crm"."quick_reply_actions" USING btree ("company_id","quick_reply_id","order");--> statement-breakpoint
CREATE INDEX "sticker_favorites_company_user_idx" ON "crm"."sticker_favorites" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX "stickers_company_idx" ON "crm"."stickers" USING btree ("company_id","created_at");