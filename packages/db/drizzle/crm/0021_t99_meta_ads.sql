CREATE TABLE "crm"."meta_ad_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"fb_account_id" text NOT NULL,
	"name" text,
	"currency" text,
	"account_status" integer,
	"included_in_dashboard" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."meta_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"fb_user_id" text NOT NULL,
	"fb_user_name" text,
	"picture_url" text,
	"access_token_enc" text NOT NULL,
	"token_expires_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"connected_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crm"."meta_ad_accounts" ADD CONSTRAINT "meta_ad_accounts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."meta_ad_accounts" ADD CONSTRAINT "meta_ad_accounts_profile_id_meta_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "crm"."meta_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."meta_profiles" ADD CONSTRAINT "meta_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."meta_profiles" ADD CONSTRAINT "meta_profiles_connected_by_user_id_users_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meta_ad_accounts_profile_account_uq" ON "crm"."meta_ad_accounts" USING btree ("profile_id","fb_account_id");--> statement-breakpoint
CREATE INDEX "meta_ad_accounts_company_idx" ON "crm"."meta_ad_accounts" USING btree ("company_id","profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meta_profiles_company_fb_user_uq" ON "crm"."meta_profiles" USING btree ("company_id","fb_user_id");--> statement-breakpoint
CREATE INDEX "meta_profiles_company_idx" ON "crm"."meta_profiles" USING btree ("company_id","created_at");