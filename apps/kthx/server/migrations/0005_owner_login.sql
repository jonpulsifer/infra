-- Ownership is a tailnet login as well as a bearer.
--
-- 0005 and not 0004: the live control database already records a
-- `0004_owner_identity.sql` from a reverted branch, and the ledger is keyed by
-- filename (`db.ts`), so a file spelled 0004 would be skipped there and run
-- everywhere else forever.
--
-- The two columns that branch left behind go with it. They hold no rows, and
-- keeping a column that means "Google subject" beside one that means "tailnet
-- login" is how the next reader merges two identity namespaces.
--
-- `token_hash` stays nullable, and every database is made to agree. It is not a
-- schema anyone wants — every claim mints a bearer — but migrations run inside
-- `start()` before `Bun.serve`, so a null that appeared between a pre-flight
-- and a `set not null` would be a crash loop rather than one failed statement,
-- and a site whose bearer is ever revoked legitimately has none. `opensSite`
-- answers false on a null hash instead. Dropping it here rather than leaving
-- 0001's `not null` in place is what stops the live database and a fresh one
-- from being two different schemas that only one code path has ever met.

alter table sites add column if not exists owner_login text;
alter table sites alter column token_hash drop not null;

alter table sites drop column if exists owner_sub;
alter table sites drop column if exists owner_email;

-- Partial: `?owner=me` is the only query that reads it, and most rows are a
-- bearer's alone.
create index if not exists sites_owner_login on sites (owner_login)
  where owner_login is not null;
