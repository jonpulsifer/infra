-- The cache engine is named after what runs, not after what it replaced.
--
-- §11 fixed the vocabulary as "two wire protocols", and `redis` was the honest
-- name for one of them while every implementation behind it was Redis. It is
-- not any more: the clusters run the Valkey project's own operator, and the
-- cloud path is Memorystore for Valkey. A Datastore whose engine says `redis`
-- names a product no Target in this fleet can provision, which is the kind of
-- gap between a name and a thing that costs an operator an afternoon.
--
-- A rename rather than an add-and-migrate: the value is the same engine under a
-- correct name, so there is no row whose meaning changes and nothing to backfill.
-- `ALTER TYPE ... RENAME VALUE` rewrites the label in place and every existing
-- `datastores.engine` follows it.

ALTER TYPE "public"."datastore_engine" RENAME VALUE 'redis' TO 'valkey';
