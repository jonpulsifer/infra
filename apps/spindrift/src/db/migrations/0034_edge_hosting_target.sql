-- A fifth runtime surface, on a second boundary that is not a cloud project.
--
-- The same two enums `0033_vercel_surface.sql` grew, grown once more and for
-- the same reason: a Target already carries its adapter, a Vessel already
-- carries its kind, and the address a `cloudflare-account` boundary states
-- lives in the `location` JSON the domain reads — so there is no column to add
-- and no row to backfill.
--
-- `ADD VALUE` runs inside the migrator's transaction on PostgreSQL 12 and
-- above, which is what CloudNativePG serves. The restriction that remains is
-- that a value added in a transaction cannot be *used* in the same one, and
-- nothing here writes a row.
ALTER TYPE "public"."target_adapter" ADD VALUE 'cloudflare-pages';--> statement-breakpoint
ALTER TYPE "public"."vessel_kind" ADD VALUE 'cloudflare-account';
