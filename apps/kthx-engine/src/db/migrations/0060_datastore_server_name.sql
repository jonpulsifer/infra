-- A managed Postgres Datastore archives its WAL under a prefix, and the barman
-- plugin's default is the Cluster name. A Datastore destroyed and created again
-- under one name then archives into the history of the one it replaced, and the
-- plugin refuses it: the Cluster reports `ContinuousArchivingFailing` and never
-- takes a backup.
--
-- This column is the prefix of one generation of a Datastore, written once when
-- the row is created. Nullable, because every row older than the column keeps
-- the default prefix its Cluster already archives under.
ALTER TABLE "datastores" ADD COLUMN "server_name" text;
