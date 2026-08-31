-- kthx leaves this database.
--
-- The zone is its own process now, with its own control database and a Postgres
-- database per site; nothing in Spindrift reads or writes these three tables.
-- The rows that still mattered -- the names, who owns them, and which release
-- serves -- were carried across before this ran (`scripts/kthx-carry-over.sh`),
-- so dropping here loses nothing that is still addressable.
--
-- `kthx_kv` is not carried anywhere. The v1 key->JSON plane is retired and
-- `/_/*` answers 410; v2's `/api/db` is collections in the site's own database
-- and there is no translation between the two shapes.
--
-- Order matters only to the reader: `kthx_kv` and `kthx_releases` both carry a
-- cascading foreign key to `kthx_sites`, so the dependants go first.
DROP TABLE IF EXISTS "kthx_kv";
--> statement-breakpoint
DROP TABLE IF EXISTS "kthx_releases";
--> statement-breakpoint
DROP TABLE IF EXISTS "kthx_sites";
