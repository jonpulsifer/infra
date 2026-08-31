-- What a site has spent on `/api/ai` today.
--
-- One row per site per UTC day, in the control database rather than in a
-- counter this process holds: the budget is the operator's money, and a
-- restart must not hand every site a fresh 200 requests. `requests` is
-- incremented at dispatch by the same statement that checks the ceiling, so
-- two calls in flight cannot both read "199 spent" and both be let through.
--
-- Rows are never pruned here: a year of every site is a few hundred kilobytes,
-- and the history is the only record of what the passthrough cost.

create table if not exists ai_usage (
  site text not null references sites(name) on delete cascade,
  day date not null,
  requests integer not null default 0,
  tokens bigint not null default 0,
  primary key (site, day)
);
