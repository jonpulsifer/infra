-- A Datastore grows the three columns its lifecycle is made of.
--
-- The table held what a human authored — name, engine, provenance, where it
-- sits, and where the credential lives — and nothing about what the platform
-- has done with it. That was enough while `provision` had no caller: an
-- `external` Datastore *is* its authored connection reference, so the row was
-- complete on insert. A `managed` one is not, and the three columns are the
-- three questions the reconcile loop has to be able to answer between the
-- insert and the credential existing.
--
-- `ref` is not `connection_ref` and the two are not one column under two
-- names. `ref` is the **adapter's handle on the object it created** — opaque
-- to core, handed straight back to `observe` and `destroy`, and spelled
-- differently by every backend (`<engine>/<namespace>/<name>` in the cluster,
-- a project-scoped resource path in the cloud). `connection_ref` is **where
-- the credential lives** — a `secret://` or a bare address, read by the render
-- path and by nothing else. One says which object to poll; the other says what
-- to hand a container. A datastore that exists and is not yet usable has the
-- first and not the second, which is the ordinary state of every healthy
-- provision and the reason they cannot share a column.
--
-- `phase` defaults to PENDING because the row is inserted **before** the
-- adapter is called: the unique key below has to reject a duplicate name
-- before anything is created on the far side, so there is a moment where a row
-- exists and nothing has been provisioned for it. Backfilled to LIVE for every
-- existing row, which is honest — the only Datastores that predate this
-- migration are `external` ones a human authored with a working URL, and a
-- loop that found them PENDING would poll an adapter that has no handle to
-- poll with.
--
-- The unique key is on (target_id, name) rather than name alone: §11 places a
-- Datastore on a Target, and two clusters each holding a `primary` are two
-- objects that never meet. Within one Target they are one object — every
-- adapter names what it provisions after the Datastore — so the second insert
-- adopts the first under server-side apply, and destroying either takes the
-- other's storage with it.
ALTER TABLE "datastores" ADD COLUMN "ref" text;
--> statement-breakpoint
ALTER TABLE "datastores" ADD COLUMN "phase" "public"."deploy_phase" DEFAULT 'PENDING' NOT NULL;
--> statement-breakpoint
ALTER TABLE "datastores" ADD COLUMN "detail" text;
--> statement-breakpoint
UPDATE "datastores" SET "phase" = 'LIVE';
--> statement-breakpoint
ALTER TABLE "datastores" ADD CONSTRAINT "datastores_target_name_unique" UNIQUE("target_id","name");
