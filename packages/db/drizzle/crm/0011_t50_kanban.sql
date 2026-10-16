CREATE TABLE "crm"."crms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."crm_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"crm_id" uuid NOT NULL,
	"column_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"position" double precision NOT NULL,
	"value_cents" bigint DEFAULT 0 NOT NULL,
	"currency" char(3) DEFAULT 'BRL' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."crm_columns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"crm_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"accent_color" text,
	"conversion_goal" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_columns_accent_color_check" CHECK ("crm"."crm_columns"."accent_color" is null or "crm"."crm_columns"."accent_color" ~ '^#[0-9A-Fa-f]{6}$')
);
--> statement-breakpoint
ALTER TABLE "crm"."crms" ADD CONSTRAINT "crms_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."crm_cards" ADD CONSTRAINT "crm_cards_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."crm_cards" ADD CONSTRAINT "crm_cards_crm_id_crms_id_fk" FOREIGN KEY ("crm_id") REFERENCES "crm"."crms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."crm_cards" ADD CONSTRAINT "crm_cards_column_id_crm_columns_id_fk" FOREIGN KEY ("column_id") REFERENCES "crm"."crm_columns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."crm_cards" ADD CONSTRAINT "crm_cards_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "crm"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."crm_columns" ADD CONSTRAINT "crm_columns_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."crm_columns" ADD CONSTRAINT "crm_columns_crm_id_crms_id_fk" FOREIGN KEY ("crm_id") REFERENCES "crm"."crms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crms_company_idx" ON "crm"."crms" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_cards_crm_chat_uq" ON "crm"."crm_cards" USING btree ("crm_id","chat_id");--> statement-breakpoint
CREATE INDEX "crm_cards_company_crm_column_idx" ON "crm"."crm_cards" USING btree ("company_id","crm_id","column_id","position");--> statement-breakpoint
CREATE INDEX "crm_cards_company_chat_idx" ON "crm"."crm_cards" USING btree ("company_id","chat_id");--> statement-breakpoint
CREATE INDEX "crm_columns_company_crm_idx" ON "crm"."crm_columns" USING btree ("company_id","crm_id","position");