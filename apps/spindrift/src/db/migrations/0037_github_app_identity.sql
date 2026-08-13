-- The GitHub App identity replaces Device Flow.
--
-- `github_app` is the singleton the manifest-flow conversion writes: the App's
-- public identity (`app_id`, `slug`, `client_id`) beside its keyring-sealed
-- private key and — nullable, because the conversion response types it
-- `string | null` — its keyring-sealed webhook secret. Installation tokens are
-- minted from the key per use; nothing durable holds one.
--
-- The Device Flow tables are dropped, not migrated. A user access token cannot
-- be transformed into an App key, so there is nothing to carry: an installation
-- with rows here simply sees "no App identity — create one" on the
-- Repositories screen and is whole again in two clicks.
CREATE TABLE "github_app" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"app_id" text NOT NULL,
	"slug" text NOT NULL,
	"client_id" text NOT NULL,
	"encrypted_private_key" text NOT NULL,
	"encrypted_webhook_secret" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_app_singleton" CHECK ("github_app"."id" = 1)
);
--> statement-breakpoint
DROP TABLE "github_device_authorizations";--> statement-breakpoint
DROP TABLE "github_oauth_credentials";
