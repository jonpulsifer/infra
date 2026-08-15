-- Story 112: hand a build a secret it never bakes.
--
-- A `build_secret` row is the second list §112 argues for — the same two pin
-- columns as `secret_ref`, resolved by a different actor (core, at dispatch)
-- on a different clock (the next build, never a running pod). It never enters
-- the pinned config document, so rotating one mints no Deploy.
--
-- `build_secret_names` records, per Build, which secrets that build could
-- read — names only, never values and never store references.
--
-- `ADD VALUE` runs inside the migrator's transaction on PostgreSQL 12 and
-- later, so long as nothing in the same transaction uses the new value —
-- nothing here does.
ALTER TYPE "public"."config_item_kind" ADD VALUE 'build_secret';
--> statement-breakpoint
ALTER TABLE "builds" ADD COLUMN "build_secret_names" jsonb;
