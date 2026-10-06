-- Route names now say where the build runs: `hosted` → `github`, `managed` →
-- `gcp`, `pool` → `bosun`. The old three were adjectives: `hosted` and
-- `managed` are synonyms of each other, and `managed` already meant something
-- else on the Datastore axis (`provenance`).
--
-- `apps.build_route` is a *pointer into current configuration*, so it has to
-- follow. A pin naming no configured route is not a soft fallback: it becomes
-- `demand.routes`, every route lands `not-admitted`, and `selectBuildRoute`
-- answers `null` — the App simply stops building. An installation that never
-- used the old names updates nothing, which is what makes this safe for all.
--
-- `builds.runner` is deliberately NOT rewritten. It is a *record of what
-- happened*, and a Build that ran on a route called `hosted` did run on a route
-- called `hosted`. `commands/views.ts` already reads an unmatched runner as
-- `runnerAdapter: null` — "a route can be retired while its Builds stay
-- readable" — which is the honest reading and costs those rows only their
-- platform mark.
UPDATE "apps" SET "build_route" = 'github' WHERE "build_route" = 'hosted';
--> statement-breakpoint
UPDATE "apps" SET "build_route" = 'gcp' WHERE "build_route" = 'managed';
--> statement-breakpoint
UPDATE "apps" SET "build_route" = 'bosun' WHERE "build_route" = 'pool';
