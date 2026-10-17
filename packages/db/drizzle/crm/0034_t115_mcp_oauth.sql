CREATE TABLE "crm"."mcp_oauth_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"state" text,
	"scope" text NOT NULL,
	"resource" text NOT NULL,
	"user_id" uuid,
	"code_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."mcp_oauth_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_hash" text,
	"client_name" text,
	"redirect_uris" jsonb NOT NULL,
	"token_endpoint_auth_method" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_oauth_clients_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "crm"."mcp_oauth_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"user_id" uuid,
	"authorization_id" uuid,
	"client_name" text NOT NULL,
	"scope" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."mcp_oauth_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"access_hash" text NOT NULL,
	"refresh_hash" text NOT NULL,
	"access_expires_at" timestamp with time zone NOT NULL,
	"refresh_expires_at" timestamp with time zone NOT NULL,
	"rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crm"."mcp_oauth_authorizations" ADD CONSTRAINT "mcp_oauth_authorizations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."mcp_oauth_authorizations" ADD CONSTRAINT "mcp_oauth_authorizations_credential_id_mcp_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "crm"."mcp_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."mcp_oauth_authorizations" ADD CONSTRAINT "mcp_oauth_authorizations_client_id_mcp_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "crm"."mcp_oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."mcp_oauth_authorizations" ADD CONSTRAINT "mcp_oauth_authorizations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "crm"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."mcp_oauth_grants" ADD CONSTRAINT "mcp_oauth_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."mcp_oauth_grants" ADD CONSTRAINT "mcp_oauth_grants_credential_id_mcp_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "crm"."mcp_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."mcp_oauth_grants" ADD CONSTRAINT "mcp_oauth_grants_client_id_mcp_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "crm"."mcp_oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."mcp_oauth_grants" ADD CONSTRAINT "mcp_oauth_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."mcp_oauth_grants" ADD CONSTRAINT "mcp_oauth_grants_authorization_id_mcp_oauth_authorizations_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "crm"."mcp_oauth_authorizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."mcp_oauth_tokens" ADD CONSTRAINT "mcp_oauth_tokens_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."mcp_oauth_tokens" ADD CONSTRAINT "mcp_oauth_tokens_grant_id_mcp_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "crm"."mcp_oauth_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_authorizations_code_hash_uq" ON "crm"."mcp_oauth_authorizations" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "mcp_oauth_authorizations_company_idx" ON "crm"."mcp_oauth_authorizations" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "mcp_oauth_grants_company_idx" ON "crm"."mcp_oauth_grants" USING btree ("company_id","credential_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_tokens_access_hash_uq" ON "crm"."mcp_oauth_tokens" USING btree ("access_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_tokens_refresh_hash_uq" ON "crm"."mcp_oauth_tokens" USING btree ("refresh_hash");--> statement-breakpoint
CREATE INDEX "mcp_oauth_tokens_company_idx" ON "crm"."mcp_oauth_tokens" USING btree ("company_id","grant_id");