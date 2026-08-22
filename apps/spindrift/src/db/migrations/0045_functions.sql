-- Functions: one author-written `fetch` handler and where it last deployed to
-- (`src/functions/contract.ts`).
--
-- `target` is `text` with a CHECK rather than a `pg_enum`, because the set of
-- targets is the deployers' — `FunctionDeployers` in the contract — and an
-- enum would turn a removed deployer into a migration of its own.
--
-- `error` lives on this row, not a side table: a Save that deployed nothing
-- still saved, so a deploy failure is state on the thing that failed to
-- deploy, not a reason the save itself is unavailable.
CREATE TABLE "functions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"target" text NOT NULL,
	"source" text NOT NULL,
	"url" text,
	"deployed_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "functions_name_unique" UNIQUE("name"),
	CONSTRAINT "functions_target" CHECK ("functions"."target" in ('cloudflare-workers','cloud-run-functions'))
);
