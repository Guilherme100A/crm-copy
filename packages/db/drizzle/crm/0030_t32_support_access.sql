CREATE TABLE "crm"."support_access_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"support_user_id" uuid NOT NULL,
	"request_id" uuid,
	"granted_by_user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."support_access_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"support_user_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"resent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crm"."support_access_grants" ADD CONSTRAINT "support_access_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."support_access_grants" ADD CONSTRAINT "support_access_grants_support_user_id_users_id_fk" FOREIGN KEY ("support_user_id") REFERENCES "crm"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."support_access_grants" ADD CONSTRAINT "support_access_grants_request_id_support_access_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "crm"."support_access_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."support_access_grants" ADD CONSTRAINT "support_access_grants_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."support_access_grants" ADD CONSTRAINT "support_access_grants_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."support_access_requests" ADD CONSTRAINT "support_access_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."support_access_requests" ADD CONSTRAINT "support_access_requests_support_user_id_users_id_fk" FOREIGN KEY ("support_user_id") REFERENCES "crm"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."support_access_requests" ADD CONSTRAINT "support_access_requests_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_access_grants_company_idx" ON "crm"."support_access_grants" USING btree ("company_id","support_user_id","expires_at");--> statement-breakpoint
CREATE INDEX "support_access_grants_support_idx" ON "crm"."support_access_grants" USING btree ("support_user_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "support_access_requests_pending_uq" ON "crm"."support_access_requests" USING btree ("company_id","support_user_id") WHERE "crm"."support_access_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "support_access_requests_company_idx" ON "crm"."support_access_requests" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX "support_access_requests_support_idx" ON "crm"."support_access_requests" USING btree ("support_user_id","created_at");