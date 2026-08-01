-- Unwrap the double-encoded jsonb documents written before `jsonbDocument`.
--
-- Every jsonb column was written as `JSON.stringify(JSON.stringify(doc))` — a
-- scalar — so `jsonb_typeof` is 'string' and no `->>` can read inside one. This
-- rewrites those rows to the document they always meant.
--
-- Guarded three ways, because this runs at startup and a failure here is an
-- installation that will not boot:
--   * `jsonb_typeof(...) = 'string'` makes it idempotent and safe on a table
--     that is half-migrated — rows already stored as an object or array are not
--     touched, and re-running changes nothing.
--   * `pg_input_is_valid(..., 'jsonb')` (Postgres 16+) skips a string that is
--     not parseable JSON rather than aborting the transaction on the cast. Such
--     a row would stay double-encoded and readable — the decoder still parses a
--     string — rather than taking the process down.
--   * SQL NULL is never a 'string', so nullable columns are left alone.

UPDATE "installation" SET "manifest" = ("manifest" #>> '{}')::jsonb
WHERE jsonb_typeof("manifest") = 'string'
  AND pg_input_is_valid("manifest" #>> '{}', 'jsonb');
--> statement-breakpoint
UPDATE "creation_drafts" SET "draft" = ("draft" #>> '{}')::jsonb
WHERE jsonb_typeof("draft") = 'string'
  AND pg_input_is_valid("draft" #>> '{}', 'jsonb');
--> statement-breakpoint
UPDATE "targets" SET "connection" = ("connection" #>> '{}')::jsonb
WHERE jsonb_typeof("connection") = 'string'
  AND pg_input_is_valid("connection" #>> '{}', 'jsonb');
--> statement-breakpoint
UPDATE "targets" SET "prerequisites" = ("prerequisites" #>> '{}')::jsonb
WHERE jsonb_typeof("prerequisites") = 'string'
  AND pg_input_is_valid("prerequisites" #>> '{}', 'jsonb');
--> statement-breakpoint
UPDATE "targets" SET "discovery" = ("discovery" #>> '{}')::jsonb
WHERE jsonb_typeof("discovery") = 'string'
  AND pg_input_is_valid("discovery" #>> '{}', 'jsonb');
--> statement-breakpoint
UPDATE "builds" SET "artifact_refs" = ("artifact_refs" #>> '{}')::jsonb
WHERE jsonb_typeof("artifact_refs") = 'string'
  AND pg_input_is_valid("artifact_refs" #>> '{}', 'jsonb');
--> statement-breakpoint
UPDATE "builds" SET "provenance" = ("provenance" #>> '{}')::jsonb
WHERE jsonb_typeof("provenance") = 'string'
  AND pg_input_is_valid("provenance" #>> '{}', 'jsonb');
--> statement-breakpoint
UPDATE "builds" SET "signature" = ("signature" #>> '{}')::jsonb
WHERE jsonb_typeof("signature") = 'string'
  AND pg_input_is_valid("signature" #>> '{}', 'jsonb');
--> statement-breakpoint
UPDATE "deploys" SET "config_document" = ("config_document" #>> '{}')::jsonb
WHERE jsonb_typeof("config_document") = 'string'
  AND pg_input_is_valid("config_document" #>> '{}', 'jsonb');
--> statement-breakpoint
UPDATE "deploys" SET "debug" = ("debug" #>> '{}')::jsonb
WHERE jsonb_typeof("debug") = 'string'
  AND pg_input_is_valid("debug" #>> '{}', 'jsonb');
