-- A Datastore is anchored to the Vessel it lives in, not to one surface on it.
--
-- What a database actually occupies is the boundary — the cluster, or the
-- project and its VPC — and on a cluster the Target and the vessel coincide,
-- which is what kept the wrong foreign key invisible. Two Cloud Run Targets in
-- one project would each provision into the same place, so the column moves to
-- the boundary and the unique key follows it: two Datastores of one name in
-- one vessel are one object on the far side, whether or not that vessel
-- carries two surfaces.
--
-- Additive, then narrowing. The backfill is total — `target_id` is NOT NULL
-- and `targets.vessel_id` is NOT NULL — and SET NOT NULL is the loud check
-- that it was. No adapter is called anywhere in this file: `ref` already
-- encodes everything `observe` and `destroy` need, so a migrated row keeps
-- addressing exactly the object it did before, and nothing re-provisions.
ALTER TABLE "datastores" ADD COLUMN "vessel_id" uuid;
--> statement-breakpoint
UPDATE "datastores" SET "vessel_id" = "targets"."vessel_id" FROM "targets" WHERE "datastores"."target_id" = "targets"."id";
--> statement-breakpoint
ALTER TABLE "datastores" ALTER COLUMN "vessel_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "datastores" ADD CONSTRAINT "datastores_vessel_id_vessels_id_fk" FOREIGN KEY ("vessel_id") REFERENCES "public"."vessels"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- The one step that can fail on live data: two Datastores of one name on two
-- surfaces of one vessel — the exact state the new key exists to forbid. It
-- cannot have happened (only kubernetes and cloudrun ever had datastore
-- adapters, and a cloudrun provision throws before its row survives), but a
-- migration that silently dropped a row would be the worst possible way to
-- discover that reasoning was wrong, so the collision is asserted empty and
-- the whole migration fails loudly if it is not.
DO $$
DECLARE
  collisions integer;
BEGIN
  SELECT count(*) INTO collisions FROM (
    SELECT "vessel_id", "name" FROM "datastores"
    GROUP BY "vessel_id", "name" HAVING count(*) > 1
  ) AS duplicated;
  IF collisions > 0 THEN
    RAISE EXCEPTION 'datastores: % (vessel, name) pair(s) held by more than one row — reconcile the duplicates by hand before this migration can apply', collisions;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "datastores" DROP CONSTRAINT "datastores_target_name_unique";
--> statement-breakpoint
ALTER TABLE "datastores" ADD CONSTRAINT "datastores_vessel_name_unique" UNIQUE("vessel_id","name");
--> statement-breakpoint
ALTER TABLE "datastores" DROP COLUMN "target_id";
