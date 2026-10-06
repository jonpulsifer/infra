ALTER TABLE "builds" ADD COLUMN "verified_build_level" integer;--> statement-breakpoint
ALTER TABLE "builds" ADD COLUMN "signature" jsonb;--> statement-breakpoint
ALTER TABLE "builds" ADD COLUMN "buildkit_provenance_ref" text;--> statement-breakpoint
ALTER TABLE "builds" ADD COLUMN "sbom_ref" text;