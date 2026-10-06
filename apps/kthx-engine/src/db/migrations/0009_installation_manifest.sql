CREATE TABLE "installation" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"manifest" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installation_singleton" CHECK ("installation"."id" = 1)
);
