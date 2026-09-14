-- What the builder wrote, and what a login has spent writing it.
--
-- A build row is a draft, not a site. It is written the moment a document
-- exists and before anything is claimed, because a claim is a real Postgres
-- database and a person confirms the name first — so the minutes between "here
-- is your page" and "put it online", which is where a phone locks and discards
-- the tab, cost nothing. A tab discarded while the model is still writing is a
-- different thing and no row here helps: the generation stops when the socket
-- does, so there is no document to keep. `site` is null until a turn is a
-- change to a named one, and there is no foreign key: a build outlives every
-- name it was never given, and a nuke that took these rows would take the
-- drafts with it.
--
-- ponytail: nothing prunes `builds`. A row is a few kilobytes of HTML; a year
-- of one household is megabytes, so the sweep can wait for a second household.

create table if not exists builds (
  id uuid primary key,
  owner_login text not null,
  site text,
  name text not null,
  ask text not null,
  document text not null,
  at timestamptz(3) not null default now()
);

create index if not exists builds_owner on builds (owner_login, at desc);

-- The build budget, keyed by login rather than by site.
--
-- Its own table rather than a row in `ai_usage`: that one has a foreign key to
-- `sites`, and the whole point of this route is that it runs before there is a
-- site to charge. Spent and refunded exactly as the AI budget is — counted at
-- dispatch by the statement that checks the ceiling, so two calls in flight
-- cannot both read the last one as free.

create table if not exists build_usage (
  login text not null,
  day date not null,
  requests integer not null default 0,
  tokens bigint not null default 0,
  primary key (login, day)
);
