-- A Component's vanity label and pinned zone are its own.
--
-- Each Component mints its own names, so the label and the zone they are minted
-- from belong to it. One label on the App cannot name two Components that serve
-- the network, and one pinned zone cannot fit two Components of different reach.
--
-- The App's label and zone move to the App's one network-serving Component: a
-- `website`, or a `service` with `expose`. That is the only Component the
-- reconciler published the label for, so the names that Component answers on
-- stay the same.
--
-- An App with several serving Components published no vanity name, so neither
-- the label nor the zone is copied onto any of them: picking one would publish
-- a name nobody chose for it. Their owner sets each Component's name. The
-- zone is also not copied to a Component that does not serve the network,
-- which then takes the first zone that serves its reach.
--
-- No App default is kept. The installation's zone order is the default, and an
-- App-level pin would bring back the zone that cannot fit every reach.
ALTER TABLE "components" ADD COLUMN "zone" text;
--> statement-breakpoint
ALTER TABLE "components" ADD COLUMN "vanity_label" text;
--> statement-breakpoint
UPDATE "components" AS "component"
SET "zone" = "app"."zone",
	"vanity_label" = "app"."vanity_domain"
FROM "apps" AS "app"
WHERE "component"."app_id" = "app"."id"
	AND ("component"."kind" = 'website' OR "component"."expose" IS TRUE)
	AND (
		SELECT count(*)
		FROM "components" AS "sibling"
		WHERE "sibling"."app_id" = "app"."id"
			AND ("sibling"."kind" = 'website' OR "sibling"."expose" IS TRUE)
	) = 1;
--> statement-breakpoint
ALTER TABLE "apps" DROP COLUMN "zone";
--> statement-breakpoint
ALTER TABLE "apps" DROP COLUMN "vanity_domain";
