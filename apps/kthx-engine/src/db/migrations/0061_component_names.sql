-- A Component's vanity label and pinned zone are its own.
--
-- Each Component mints its own names, so the label and the zone they are minted
-- from belong to it. One label on the App cannot name two Components that serve
-- the network, and one pinned zone cannot fit two Components of different reach.
--
-- The App's zone is copied onto every Component of the App. The deploy loop
-- minted each Component's canonical name in that zone, so every name stays where
-- it is. A Component whose reach the zone does not serve gets the pin too: the
-- deploy loop falls through to the first zone serving its reach, as it does
-- today, and the console warns on its card.
--
-- The App's label is copied onto the App's one network-serving Component: a
-- `website`, or a `service` with `expose`. That is the only Component the
-- reconciler published the label for. An App with several serving Components
-- published no vanity name, so the label is copied onto none of them: picking
-- one would publish a name nobody chose for it.
--
-- No App default is kept. The installation's zone order is the default, and an
-- App-level pin would bring back the zone that cannot fit every reach.
ALTER TABLE "components" ADD COLUMN "zone" text;
--> statement-breakpoint
ALTER TABLE "components" ADD COLUMN "vanity_label" text;
--> statement-breakpoint
UPDATE "components" AS "component"
SET "zone" = "app"."zone"
FROM "apps" AS "app"
WHERE "component"."app_id" = "app"."id"
	AND "app"."zone" IS NOT NULL;
--> statement-breakpoint
UPDATE "components" AS "component"
SET "vanity_label" = "app"."vanity_domain"
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
