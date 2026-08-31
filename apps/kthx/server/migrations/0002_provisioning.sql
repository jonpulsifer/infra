-- When a name got its own Postgres database and role.
--
-- Null means the claim inserted this row and did not finish: `/api/db` on such
-- a site is 503 BUSY and the next touch re-runs the provisioning statements,
-- which are idempotent. It is also null for every site claimed before there was
-- a database to give one, which is what makes the start-up repair pick them up.

alter table sites add column if not exists provisioned_at timestamptz(3);
