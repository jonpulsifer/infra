CREATE TABLE "registry_credentials" (
	"host" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"secret" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
