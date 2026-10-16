CREATE TABLE "crm"."mcp_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"auth_type" text DEFAULT 'static' NOT NULL,
	"token_hash" text,
	"token_hint" text,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crm"."mcp_credentials" ADD CONSTRAINT "mcp_credentials_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."mcp_credentials" ADD CONSTRAINT "mcp_credentials_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_credentials_token_hash_uq" ON "crm"."mcp_credentials" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "mcp_credentials_company_idx" ON "crm"."mcp_credentials" USING btree ("company_id","created_at");