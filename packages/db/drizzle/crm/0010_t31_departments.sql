CREATE TABLE "crm"."business_hour_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"action_type" text DEFAULT 'message' NOT NULL,
	"message_text" text,
	"flow_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_hour_configs_action_ck" CHECK ("crm"."business_hour_configs"."action_type" in ('message', 'flow'))
);
--> statement-breakpoint
CREATE TABLE "crm"."business_hours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"config_id" uuid NOT NULL,
	"day_of_week" smallint NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "business_hours_day_ck" CHECK ("crm"."business_hours"."day_of_week" between 0 and 6)
);
--> statement-breakpoint
CREATE TABLE "crm"."departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#3B82F6' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm"."member_connections" (
	"company_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_connections_member_id_connection_id_pk" PRIMARY KEY("member_id","connection_id")
);
--> statement-breakpoint
CREATE TABLE "crm"."member_departments" (
	"company_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_departments_member_id_department_id_pk" PRIMARY KEY("member_id","department_id")
);
--> statement-breakpoint
ALTER TABLE "crm"."business_hour_configs" ADD CONSTRAINT "business_hour_configs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."business_hour_configs" ADD CONSTRAINT "business_hour_configs_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "crm"."flows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."business_hours" ADD CONSTRAINT "business_hours_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."business_hours" ADD CONSTRAINT "business_hours_config_id_business_hour_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "crm"."business_hour_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."departments" ADD CONSTRAINT "departments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."member_connections" ADD CONSTRAINT "member_connections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."member_connections" ADD CONSTRAINT "member_connections_member_id_company_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "crm"."company_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."member_departments" ADD CONSTRAINT "member_departments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."member_departments" ADD CONSTRAINT "member_departments_member_id_company_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "crm"."company_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."member_departments" ADD CONSTRAINT "member_departments_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "crm"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "business_hour_configs_company_connection_uq" ON "crm"."business_hour_configs" USING btree ("company_id","connection_id");--> statement-breakpoint
CREATE INDEX "business_hour_configs_company_flow_idx" ON "crm"."business_hour_configs" USING btree ("company_id","flow_id");--> statement-breakpoint
CREATE INDEX "business_hours_company_config_idx" ON "crm"."business_hours" USING btree ("company_id","config_id","day_of_week");--> statement-breakpoint
CREATE INDEX "departments_company_name_idx" ON "crm"."departments" USING btree ("company_id","name");--> statement-breakpoint
CREATE INDEX "member_connections_company_conn_idx" ON "crm"."member_connections" USING btree ("company_id","connection_id");--> statement-breakpoint
CREATE INDEX "member_departments_company_dept_idx" ON "crm"."member_departments" USING btree ("company_id","department_id");--> statement-breakpoint
ALTER TABLE "crm"."chats" ADD CONSTRAINT "chats_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "crm"."departments"("id") ON DELETE set null ON UPDATE no action;