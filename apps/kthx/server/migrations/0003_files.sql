-- A site's files: what is stored, who put it there, and what it weighs.
--
-- In the control database rather than the site's own, for two reasons: the
-- files budget is 256 MiB *beside* the database's own 256 MiB, and
-- `pg_database_size` is the database meter — metadata rows stored there would
-- spend the quota they are measuring. It also means `/files/*` keeps serving
-- while a site's database is being provisioned or repaired.
--
-- `owner` is the visitor id that created the path — the ownership floor: a path
-- is overwritten and deleted by that visitor or by the site's bearer, nobody
-- else. `sha256` is the etag `/files/<path>` answers with.

create table if not exists files (
  site text not null references sites(name) on delete cascade,
  path text not null,
  owner text not null,
  size bigint not null,
  type text not null,
  sha256 text not null,
  updated_at timestamptz(3) not null default now(),
  primary key (site, path)
);
