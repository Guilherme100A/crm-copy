CREATE TABLE "ai_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"provider" text,
	"api_key_ciphertext" "bytea",
	"api_key_iv" "bytea",
	"api_key_auth_tag" "bytea",
	"api_key_key_version" integer,
	"model_small" text,
	"model_large" text,
	"confidence_threshold" real,
	"max_tokens" integer,
	"timeout_ms" integer,
	"enabled" boolean,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_settings_singleton_check" CHECK ("ai_settings"."id" = 1),
	CONSTRAINT "ai_settings_threshold_check" CHECK ("ai_settings"."confidence_threshold" is null or ("ai_settings"."confidence_threshold" >= 0 and "ai_settings"."confidence_threshold" <= 1)),
	CONSTRAINT "ai_settings_limits_check" CHECK (("ai_settings"."max_tokens" is null or "ai_settings"."max_tokens" >= 1) and ("ai_settings"."timeout_ms" is null or "ai_settings"."timeout_ms" >= 1))
);
