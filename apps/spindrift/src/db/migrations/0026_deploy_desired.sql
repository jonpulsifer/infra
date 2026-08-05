-- A Deploy carries the document it places, and every Deploy has one.
--
-- §10 pinned `config_document` because "re-reading current config at apply time
-- would give a rollback the configuration of the release it is rolling away
-- from". `reach` and `auth` were pinned later for the same reason, stated the
-- same way. Everything else in the document — kind, expose, schedule, the names
-- — was still read from `components` at apply time, so a Component edited after
-- an intent was written retroactively changed what that intent placed, and a
-- rollback came back up with yesterday's artifact under today's shape.
--
-- One column replaces the three. It is NOT NULL on purpose: an intent whose
-- meaning has to be reassembled from rows that have moved since is not an
-- intent, and a nullable column would keep the compose-from-rows path alive as
-- a fallback, which is where the bug would keep living.
--
-- What it does not carry — the artifact (immutable on the Build this Deploy
-- names), the deploy id (this row's own key), and the hostname (a property of
-- the App, since §9's "one record re-point" only holds if a name outlives the
-- releases under it) — is why this backfill is computable from these rows
-- alone.
ALTER TABLE "deploys" ADD COLUMN "desired" jsonb;

-- Every existing row gets the document it would have been written with.
-- `jsonb_strip_nulls` is what makes `expose` and `schedule` absent rather than
-- null, matching the optional fields on `DesiredState`. `requirements` is the
-- constant `DEFAULT_PLATFORM` with no resources, which is exactly what these
-- rows were applied with — placement's arch and ceiling joins have never had a
-- stated value to compare against.
UPDATE "deploys" AS d
SET "desired" = jsonb_strip_nulls(
  jsonb_build_object(
    'app', a."name",
    'component', c."name",
    'target', t."name",
    'kind', c."kind"::text,
    'expose', c."expose",
    'reach', COALESCE(d."reach", c."reach")::text,
    'auth', COALESCE(d."auth", c."auth")::text,
    'schedule', c."schedule",
    'config', COALESCE(d."config_document", '[]'::jsonb),
    'requirements', jsonb_build_object(
      'platform', jsonb_build_object('os', 'linux', 'arch', 'amd64'),
      'resources', '{}'::jsonb
    )
  )
)
FROM "components" c, "apps" a, "targets" t
WHERE c."id" = d."component_id"
  AND a."id" = c."app_id"
  AND t."id" = d."target_id";

ALTER TABLE "deploys" ALTER COLUMN "desired" SET NOT NULL;

ALTER TABLE "deploys" DROP COLUMN "config_document";
ALTER TABLE "deploys" DROP COLUMN "reach";
ALTER TABLE "deploys" DROP COLUMN "auth";
