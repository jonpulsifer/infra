-- The stored manifest loses `chartContract`, because the schema just did.
--
-- Removing the key from `manifest.schema.ts` and from the mounted ConfigMap
-- leaves a third copy untouched, and it is the copy that governs:
-- `loadStoredManifest` resolves `stored ?? declaration`, and
-- `readStoredManifest` parses that row through the same `.strict()` schema
-- (`src/config/manifest-store.ts`). A strict schema rejects a key it no longer
-- declares, and `validateManifest` throws rather than degrading, so an
-- installation whose row still carried the key would not boot at all —
-- `targets.0.connection: Unrecognized key: "chartContract"`.
--
-- So the field cannot be deleted from the schema without also deleting it from
-- the documents already written under the old one. That is this file.
--
-- Ordering is already safe and needs no hook: every Deployment runs an init
-- container that blocks until the migration journal holds every migration in
-- the image (see the schema wait in
-- `packages/charts/spindrift/templates/deployment.yaml`), so no process parses
-- the document until this has run.
--
-- `targets.connection` is deliberately NOT touched. That column is a
-- `.$type<>()` cast with no runtime validation, so a stale key there is inert;
-- rewriting it would be churn for a read nothing performs.
--
-- The array is rebuilt rather than edited in place because jsonb has no
-- map-over-array. `WITH ORDINALITY` and the matching `ORDER BY` are
-- load-bearing: `reconcileManifestTargets` reads a Target's `rank` from its
-- position in this array, so an aggregate that reordered it would silently
-- re-rank every Target.
UPDATE "installation"
SET "manifest" = jsonb_set(
	"manifest",
	'{targets}',
	(
		SELECT coalesce(
			jsonb_agg(
				CASE
					WHEN jsonb_typeof("target" -> 'connection') = 'object'
						THEN jsonb_set(
							"target",
							'{connection}',
							("target" -> 'connection') - 'chartContract'
						)
					ELSE "target"
				END
				ORDER BY "position"
			),
			'[]'::jsonb
		)
		FROM jsonb_array_elements("manifest" -> 'targets')
			WITH ORDINALITY AS "entry"("target", "position")
	)
)
WHERE jsonb_typeof("manifest" -> 'targets') = 'array';
