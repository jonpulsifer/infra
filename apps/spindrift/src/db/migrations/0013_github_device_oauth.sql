CREATE TABLE "github_device_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"encrypted_device_code" text NOT NULL,
	"verification_uri" text NOT NULL,
	"interval_seconds" integer NOT NULL,
	"next_poll_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_oauth_credentials" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"github_user_id" text NOT NULL,
	"github_login" text NOT NULL,
	"encrypted_credential" text NOT NULL,
	"access_expires_at" timestamp with time zone,
	"refresh_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_oauth_credentials_singleton" CHECK ("github_oauth_credentials"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "github_device_authorizations" ADD CONSTRAINT "github_device_authorizations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
