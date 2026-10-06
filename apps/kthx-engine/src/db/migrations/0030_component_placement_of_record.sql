-- The placement of record becomes a stored fact on the Component.
--
-- "Where is this Component placed" was inferred: every reader took the
-- Component's newest `component_target_desired` row, because `placeComponent`
-- touches the pair a move commits. But every intent touches its pair's
-- `updated_at` too, so a rollback or config-set addressed at the *old* pair
-- after a move made the old row newest again, and the next deploy resolved the
-- retired Target with no `placeComponent` involved. "Newest" cannot
-- distinguish moved-here from touched-here; a column can.
--
-- `set null` on the foreign key, because a Target row that is gone leaves the
-- Component honestly unplaced rather than undeletable — the desired rows,
-- which carry the live state, already cascade.
--
-- The backfill is the inference, frozen once: the newest desired row per
-- Component is what every reader answered until this migration, so it is the
-- only honest value to promote. A Component with no desired rows stays NULL,
-- which is what unplaced has always looked like.
ALTER TABLE "components" ADD COLUMN "placed_target_id" uuid;
--> statement-breakpoint
ALTER TABLE "components" ADD CONSTRAINT "components_placed_target_id_targets_id_fk"
	FOREIGN KEY ("placed_target_id") REFERENCES "public"."targets"("id")
	ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
UPDATE "components" SET "placed_target_id" = (
	SELECT "target_id" FROM "component_target_desired" d
	WHERE d."component_id" = "components"."id"
	ORDER BY d."updated_at" DESC
	LIMIT 1
);
