-- An agent token is a long-lived credential that lives in a config file on a
-- machine, and until this column the list of them could say only when each was
-- minted. That is not enough to answer the one question an operator asks before
-- revoking: which of these is the laptop in front of me, and which is the one I
-- set up months ago and forgot. `credentials.last_used_at` already answers it
-- for passkeys; this is the same fact for the other credential.
--
-- Nullable, because "never used" is a real state and not a missing value: a
-- token minted and never presented is exactly the row an operator most wants to
-- find. Every existing row is in it — nothing was recording this before.
--
-- The two `last_used_*` strings are what the caller said it was, not what the
-- process observed: the address is the first hop of `X-Forwarded-For` and the
-- agent is `User-Agent`, both self-reported. They are here to tell one machine
-- from another, never to prove anything.
ALTER TABLE "sessions" ADD COLUMN "last_used_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "last_used_ip" text;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "last_used_agent" text;
