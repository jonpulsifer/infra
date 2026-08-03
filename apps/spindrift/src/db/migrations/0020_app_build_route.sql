-- §16 makes the route a Target's threshold and an admin's rank. This is the
-- third party to that decision: the App, which may name the route it builds on
-- so long as that route still clears the Target's threshold.
--
-- Nullable, and null is not "no route" — it is "no opinion", which is every App
-- that exists today and the whole of the behaviour before this column. Rank
-- order picks for those, exactly as it did.
ALTER TABLE "apps" ADD COLUMN "build_route" text;
