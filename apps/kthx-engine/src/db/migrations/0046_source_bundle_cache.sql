-- The commit → bundle index over the source depot (`src/db/schema.ts`
-- `sourceBundles`, read only through `src/storage/bundle-cache.ts`).
--
-- An index, not a store: the bucket stays the source of truth, so there is no
-- foreign key to `builds` and no cleanup job. A row whose object the bucket's
-- `ephemeral/` lifecycle rule has since expired is a miss, verified against
-- the depot on every read, and the next stage overwrites it in place.
--
-- `repository` and `commit` are the composite key because they are what a
-- caller holds before any bytes exist — a digest cannot be computed without
-- fetching the thing it would be the key for.
CREATE TABLE "source_bundles" (
	"repository" text NOT NULL,
	"commit" text NOT NULL,
	"digest" text NOT NULL,
	"location" text NOT NULL,
	"staged_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_bundles_repository_commit_pk" PRIMARY KEY("repository","commit")
);
