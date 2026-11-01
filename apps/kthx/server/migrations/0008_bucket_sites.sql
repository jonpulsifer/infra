-- A site is its folder and marker in the sites bucket, so a row here is only
-- what this server keeps beside it: the site's database, files and AI spend.
--
-- A row is made the first time a site's API is used, and its database the
-- first time `/api/db` or `/api/ws` is. `marker_seen_at` is when the sweep
-- last found the site's marker; the sweep drops a row whose marker it saw
-- once and no longer finds, and never a row it has not yet seen.
--
-- Bearers, holds and name tombstones go: an owner is the email on the marker,
-- and `kthx rm` frees a name. `serving`, `owner_login` and `releases` stay
-- for the one-shot move of each serving release into the bucket, which reads
-- them, and a later migration drops them.

delete from sites where deleted_at is not null;

alter table sites drop column if exists deleted_at;
alter table sites drop column if exists token_hash;
alter table sites drop column if exists held;
alter table sites add column if not exists marker_seen_at timestamptz(3);
