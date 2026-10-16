CREATE TYPE "crm"."invitation_kind" AS ENUM('member', 'platform');--> statement-breakpoint
CREATE TYPE "crm"."invitation_status" AS ENUM('pending', 'accepted', 'declined', 'cancelled');--> statement-breakpoint
CREATE TABLE "crm"."invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" "crm"."invitation_kind" DEFAULT 'member' NOT NULL,
	"email" text NOT NULL,
	"role" "crm"."member_role" DEFAULT 'member' NOT NULL,
	"status" "crm"."invitation_status" DEFAULT 'pending' NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by_user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"last_sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resends_day" date,
	"resends_today" integer DEFAULT 0 NOT NULL,
	"responded_at" timestamp with time zone,
	"accepted_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crm"."invitations" ADD CONSTRAINT "invitations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."invitations" ADD CONSTRAINT "invitations_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."invitations" ADD CONSTRAINT "invitations_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_token_hash_uq" ON "crm"."invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "invitations_company_kind_idx" ON "crm"."invitations" USING btree ("company_id","kind","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_pending_uq" ON "crm"."invitations" USING btree ("company_id","kind","email") WHERE "crm"."invitations"."status" = 'pending';