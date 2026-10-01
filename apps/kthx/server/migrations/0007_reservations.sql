-- Names the engine holds for its built apps, so no site is claimed under a
-- hostname an app serves or is about to.
--
-- A table of its own and not a `sites` row: a reservation has no bearer, no
-- database and no release, so `repairAll`, the public directory, the live-site
-- ceiling and the nuke never see one. The nuke selects only `sites`, so a
-- reservation outlives it. `holder` is the engine's app id; the engine releases
-- a holder's names only when that app is deleted.

create table if not exists reservations (
  name text primary key,
  holder text not null,
  at timestamptz(3) not null default now()
);

create index if not exists reservations_holder on reservations (holder);
