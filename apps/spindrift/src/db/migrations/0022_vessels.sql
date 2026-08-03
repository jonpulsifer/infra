-- The Vessel becomes a row.
--
-- §13 declined a noun above `Target`: "the shared thing between them is an
-- argument to a command, not an entity." That reasoning holds for the *split* —
-- a cloud project genuinely is two Targets, because placement determines
-- artifact shape — and not for the absence of the noun. What followed was a
-- boundary spelled as a name prefix, sliced back off in four separate places,
-- and boundary facts stored once per surface where two surfaces of one project
-- could disagree about them.
--
-- Additive, then narrowing, in one file: create, backfill, constrain, strip.
-- The harness replays this verbatim (`test/harness/db.ts`), so the backfill runs
-- in every database test rather than being a script nobody executes twice.

CREATE TYPE "public"."vessel_kind" AS ENUM('cluster', 'gcp-project');--> statement-breakpoint

CREATE TABLE "vessels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" "vessel_kind" NOT NULL,
	-- Nullable for the same reason `targets.connection` is: a manifest seeds a
	-- vessel's identity without necessarily stating how to reach it, and that
	-- half-ready state is one §13 intends to be visible.
	"location" jsonb,
	"served_hosts" text[],
	"reachable_registries" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vessels_name_unique" UNIQUE("name")
);--> statement-breakpoint

ALTER TABLE "targets" ADD COLUMN "vessel_id" uuid;--> statement-breakpoint

-- One vessel per cluster. Its Target keeps its own name, because there is no
-- sibling surface to disambiguate it from.
INSERT INTO "vessels" ("name", "kind", "location", "served_hosts", "reachable_registries")
SELECT
	t."name",
	'cluster'::"vessel_kind",
	CASE
		WHEN t."connection" ? 'apiServer'
		THEN jsonb_build_object('kind', 'cluster', 'apiServer', t."connection"->>'apiServer')
	END,
	ARRAY(SELECT jsonb_array_elements_text(t."connection"->'servedHosts')),
	ARRAY(SELECT jsonb_array_elements_text(t."connection"->'reachableRegistries'))
FROM "targets" t
WHERE t."adapter" = 'kubernetes';--> statement-breakpoint

-- One vessel per cloud project. **The last time a boundary is recovered from a
-- name**: the two surfaces say they share a project by being called
-- `<name>-cloudrun` and `<name>-static`, which is the convention this change
-- retires everywhere except the manifest seeding path (see #61).
--
-- `servedHosts` is unioned rather than picked from a winner. Two surfaces of one
-- project *can* state different reach today, and silently taking one would be
-- the bug the Vessel row exists to prevent.
INSERT INTO "vessels" ("name", "kind", "location", "served_hosts", "reachable_registries")
SELECT
	regexp_replace(t."name", '-(cloudrun|static)$', ''),
	'gcp-project'::"vessel_kind",
	CASE
		WHEN bool_or(t."connection" ? 'project')
		THEN jsonb_build_object(
			'kind', 'gcp-project',
			'project', min(t."connection"->>'project')
		)
	END,
	ARRAY(
		SELECT DISTINCT jsonb_array_elements_text(
			jsonb_path_query_array(jsonb_agg(t."connection"), '$[*].servedHosts[*]')
		) ORDER BY 1
	),
	ARRAY(
		SELECT DISTINCT jsonb_array_elements_text(
			jsonb_path_query_array(jsonb_agg(t."connection"), '$[*].reachableRegistries[*]')
		) ORDER BY 1
	)
FROM "targets" t
WHERE t."adapter" IN ('cloudrun', 'static')
GROUP BY regexp_replace(t."name", '-(cloudrun|static)$', '');--> statement-breakpoint

UPDATE "targets" t SET "vessel_id" = v."id"
FROM "vessels" v
WHERE v."name" = CASE
	WHEN t."adapter" = 'kubernetes' THEN t."name"
	ELSE regexp_replace(t."name", '-(cloudrun|static)$', '')
END;--> statement-breakpoint

-- An empty array is not the same claim as an absent one: absent means nobody
-- stated it, and `[]` would read as "reaches nothing" (see `exclusionsFor`).
UPDATE "vessels" SET
	"served_hosts" = CASE WHEN cardinality("served_hosts") = 0 THEN NULL ELSE "served_hosts" END,
	"reachable_registries" = CASE WHEN cardinality("reachable_registries") = 0 THEN NULL ELSE "reachable_registries" END;--> statement-breakpoint

ALTER TABLE "targets" ALTER COLUMN "vessel_id" SET NOT NULL;--> statement-breakpoint

-- `restrict`, matching `apps.repository_id`: removing a vessel must never be a
-- way to delete the Targets that reference it.
ALTER TABLE "targets" ADD CONSTRAINT "targets_vessel_id_vessels_id_fk"
	FOREIGN KEY ("vessel_id") REFERENCES "public"."vessels"("id")
	ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- The surface keeps only what is true of it and not of its neighbours. What is
-- true of the boundary now lives in exactly one place.
UPDATE "targets"
SET "connection" = "connection" - 'apiServer' - 'project' - 'servedHosts' - 'reachableRegistries'
WHERE "connection" IS NOT NULL;
