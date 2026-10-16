CREATE TABLE "crm"."processed_events" (
	"consumer" text NOT NULL,
	"event_key" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processed_events_pk" PRIMARY KEY("consumer","event_key")
);
--> statement-breakpoint
CREATE INDEX "processed_events_processed_at_idx" ON "crm"."processed_events" USING btree ("processed_at");