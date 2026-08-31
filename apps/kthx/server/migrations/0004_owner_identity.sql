-- Who owns a site: a Google account rather than a string this server minted.
--
-- `owner_sub` is what ownership compares — an address can change hands, a
-- subject id cannot — and `owner_email` is what the directory shows. Both are
-- null on a site claimed before this, which is what `POST …/adopt` fills in:
-- the old bearer opens the site exactly until the row has an owner, and
-- `token_hash` is nulled at that moment. Nothing is dropped, so a site that is
-- never adopted keeps working.

alter table sites add column if not exists owner_sub text;
alter table sites add column if not exists owner_email text;
alter table sites alter column token_hash drop not null;

create index if not exists sites_owner_sub on sites (owner_sub)
  where owner_sub is not null;
