-- A `sessions` row is now two credentials wearing one shape: the browser cookie
-- a passkey mints, and the bearer token an agent presents at `/mcp`. They share
-- the opaque-value-and-hash mechanism and nothing else, so `kind` is what keeps
-- a copied cookie from being replayed at the MCP surface and an agent token
-- from being replayed at the UI — a property of the query rather than of
-- whoever remembers to check.
--
-- Existing rows are browser sessions; until this column there was nothing else
-- that could have written one.
ALTER TABLE "sessions" ADD COLUMN "kind" text DEFAULT 'browser' NOT NULL;
