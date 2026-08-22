-- What a pass read *in* a boundary, beside the checklist saying whether this
-- installation can use it (`src/domain/vessel.ts`'s `VesselDiscovery`).
--
-- Nullable with no default and no backfill: null is "never assessed", which is
-- the state every existing vessel is honestly in until the loop's next pass
-- writes what it saw. A `'{}'::jsonb` default would claim a boundary had been
-- read and found to carry nothing.
ALTER TABLE "vessels" ADD COLUMN "discovery" jsonb;
