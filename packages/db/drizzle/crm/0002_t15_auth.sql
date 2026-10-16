CREATE TABLE "crm"."user_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"personal_whatsapp" text,
	"referred_by_code" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crm"."user_profiles" ADD CONSTRAINT "user_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "crm"."users"("id") ON DELETE cascade ON UPDATE no action;