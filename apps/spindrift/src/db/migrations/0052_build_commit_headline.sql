-- What the far side said about a commit beyond its sha, kept on the Build.
--
-- §15 fetches the exact commit once, and `GitHubApp.fetchExactCommit` already
-- pays for `GET /repos/{r}/commits/{sha}` to resolve it — it kept only `.sha`,
-- so every Build, Deploy and Source row was a bare hash, the one form of a
-- commit nobody can read during an incident. The three columns are what that
-- same response carries: the headline, who wrote it, when.
--
-- `commit_message` is the headline only — the first line, trimmed, capped at
-- 200 characters by `commitHeadlineOf` (`src/domain/source-bundle.ts`). A git
-- subject is 50–72 characters by convention and a squash-merge title with its
-- PR number rarely passes 120; 200 keeps every real headline whole and stops a
-- pasted stack trace from becoming a column.
--
-- Nullable on purpose: an archive has no commit, and a Build staged before the
-- columns existed keeps an honest null rather than a backfill that would have
-- to fetch every old commit again.
--
-- `source_bundles` carries the same three because it is the commit → bundle
-- index the stager answers cache hits from (`src/storage/bundle-cache.ts`):
-- without them the first App on a repository got a headline and every sibling
-- App staged from the cache got none.
ALTER TABLE "builds" ADD COLUMN "commit_message" text;
--> statement-breakpoint
ALTER TABLE "builds" ADD COLUMN "commit_author" text;
--> statement-breakpoint
ALTER TABLE "builds" ADD COLUMN "commit_authored_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "source_bundles" ADD COLUMN "commit_message" text;
--> statement-breakpoint
ALTER TABLE "source_bundles" ADD COLUMN "commit_author" text;
--> statement-breakpoint
ALTER TABLE "source_bundles" ADD COLUMN "commit_authored_at" timestamp with time zone;
