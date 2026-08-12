-- A Component gets its own entrypoint.
--
-- One image run several ways is what makes a monolith expressible: `web`,
-- `worker` and `cleanup` are the same artifact under three commands. The chart
-- has taken `app.command` and `app.args` since it was written
-- (`packages/charts/spindrift-app/values.yaml`); core has never sent them.
--
-- Both nullable, and NULL means the image's own entrypoint. That is what every
-- existing row means today, so there is no backfill: the absent value and the
-- old behaviour are the same statement, which is the only reason a column can
-- be added to a live table with no migration of meaning.
--
-- `jsonb` rather than `text[]` because an argv is a document nothing predicates
-- on, and because the pinned copy in `deploys.desired` is already jsonb — one
-- encoding for the two places the same list lives.
ALTER TABLE "components" ADD COLUMN "command" jsonb;--> statement-breakpoint
ALTER TABLE "components" ADD COLUMN "args" jsonb;
