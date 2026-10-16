CREATE TABLE "crm"."connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"name" text NOT NULL,
	"phone_number" text,
	"connection_state" text,
	"last_disconnect_reason" text,
	"last_status_code" integer,
	"disconnected_at" timestamp with time zone,
	"connected_at" timestamp with time zone,
	"qr_requested_at" timestamp with time zone,
	"notify_sent_by_me" boolean DEFAULT false NOT NULL,
	"ephemeral_duration" text DEFAULT 'off' NOT NULL,
	"save_contacts_enabled" boolean DEFAULT false NOT NULL,
	"scheduled_for_deletion_at" timestamp with time zone,
	"requires_restart" boolean DEFAULT false NOT NULL,
	"proxy_protocol" text,
	"proxy_host" text,
	"proxy_port" integer,
	"proxy_username" text,
	"proxy_password_enc" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connections_name_len" CHECK (char_length("crm"."connections"."name") between 2 and 100),
	CONSTRAINT "connections_ephemeral_check" CHECK ("crm"."connections"."ephemeral_duration" in ('off', '1d', '7d', '90d')),
	CONSTRAINT "connections_state_check" CHECK ("crm"."connections"."connection_state" is null or "crm"."connections"."connection_state" in ('open', 'close')),
	CONSTRAINT "connections_proxy_protocol_check" CHECK ("crm"."connections"."proxy_protocol" is null or "crm"."connections"."proxy_protocol" in ('http', 'https', 'socks5')),
	CONSTRAINT "connections_proxy_port_check" CHECK ("crm"."connections"."proxy_port" is null or "crm"."connections"."proxy_port" between 1 and 65535)
);
--> statement-breakpoint
ALTER TABLE "crm"."connections" ADD CONSTRAINT "connections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."connections" ADD CONSTRAINT "connections_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connections_session_id_uq" ON "crm"."connections" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "connections_company_created_idx" ON "crm"."connections" USING btree ("company_id","created_at");--> statement-breakpoint
ALTER TABLE "crm"."chats" ADD CONSTRAINT "chats_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "crm"."connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."business_hour_configs" ADD CONSTRAINT "business_hour_configs_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "crm"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."member_connections" ADD CONSTRAINT "member_connections_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "crm"."connections"("id") ON DELETE cascade ON UPDATE no action;