-- A Target is its vessel and its surface, so it needs no name of its own.
--
-- `targets.name` was a constructed string: the vessel's name, plus the adapter
-- as a suffix where the vessel carried more than one surface. Migration 0022
-- called slicing that suffix back off "the last time a boundary is recovered
-- from a name". This is the last time a name is constructed from one.
--
-- **Nothing is lost, because nothing was ever stored here that the two
-- surviving columns do not already state.** `vessel_id` names the boundary and
-- `adapter` names the runtime on it; the name was those two joined by a hyphen,
-- or the vessel's name alone where there was only one surface to tell apart.
-- Every persisted edge into this table is `target_id uuid` — `deploys`,
-- `component_target_desired`, `datastores`, `config_items` — so dropping the
-- column moves no foreign key and orphans no row.
--
-- The unique index follows the identity rather than the spelling of it. It is
-- also the stricter constraint: `targets_name_unique` admitted two surfaces of
-- one vessel with the same adapter as long as somebody had spelled them
-- differently, which is a state no part of the product has a meaning for. If
-- this ALTER fails on a live installation, that is the state it found, and
-- failing is the correct outcome — the rows have to be reconciled by hand
-- before either one can claim to be *the* Cloud Run surface on that project.
ALTER TABLE "targets" DROP CONSTRAINT "targets_name_unique";
--> statement-breakpoint
ALTER TABLE "targets" DROP COLUMN "name";
--> statement-breakpoint
ALTER TABLE "targets" ADD CONSTRAINT "targets_vessel_adapter_unique" UNIQUE("vessel_id","adapter");
