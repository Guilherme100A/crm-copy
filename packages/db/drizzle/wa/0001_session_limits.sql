CREATE TABLE "session_limits" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"per_minute" integer,
	"per_hour" integer,
	"per_day" integer,
	"reduction_factor" real DEFAULT 1 NOT NULL,
	"reduction_reason" text,
	"reduced_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_limits_positive_check" CHECK (coalesce("session_limits"."per_minute", 1) >= 1 and coalesce("session_limits"."per_hour", 1) >= 1 and coalesce("session_limits"."per_day", 1) >= 1),
	CONSTRAINT "session_limits_factor_check" CHECK ("session_limits"."reduction_factor" > 0 and "session_limits"."reduction_factor" <= 1)
);
--> statement-breakpoint
ALTER TABLE "session_limits" ADD CONSTRAINT "session_limits_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;