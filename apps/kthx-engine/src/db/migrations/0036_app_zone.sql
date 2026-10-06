-- The zone an App's names are minted in (§9).
--
-- Nullable, and null on every App that predates it: `dns.zones` used to name one
-- zone per reach, so reach picked the zone and there was nothing for an App to
-- say. Null keeps exactly that behaviour — the first zone serving the reach —
-- which is why this backfills nothing. Writing today's default into every row
-- would turn "no opinion" into a pin, and retiring that zone would then be a
-- rename of every App instead of a change of default.
ALTER TABLE "apps" ADD COLUMN "zone" text;
