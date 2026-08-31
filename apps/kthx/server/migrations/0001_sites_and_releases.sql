-- The control database: which names exist, who opens them, and what they serve.
--
-- A site database (ticket 03) holds a site's documents; nothing about a
-- visitor's data is here. `serving` is a column rather than a join to the
-- newest release because rolling back is the point: `held` is the latch that
-- keeps a new upload from moving it.

create table if not exists sites (
  name text primary key,
  token_hash text not null,
  serving integer,
  held boolean not null default false,
  created_at timestamptz(3) not null default now(),
  -- Set rather than deleted: a deleted name answers 410 forever, and the row
  -- is what makes it do that instead of coming free for the next claimer.
  deleted_at timestamptz(3)
);

create table if not exists releases (
  site text not null references sites(name) on delete cascade,
  n integer not null,
  digest text not null,
  size bigint not null,
  -- Where the tar.gz lives, so a lost volume rehydrates. Content-addressed, so
  -- two sites uploading identical bytes name one object.
  location text not null,
  at timestamptz(3) not null default now(),
  primary key (site, n)
);
