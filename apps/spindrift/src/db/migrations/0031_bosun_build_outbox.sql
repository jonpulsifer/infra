-- The bosun build route's outbox.
--
-- Bosun is a warm-pool microVM runner daemon this process cannot dial — it
-- long-polls in over three shared-secret-authed endpoints instead. A row here
-- is the queue entry that makes that direction of contact possible: enqueued
-- PENDING, claimed CLAIMED for the life of a lease, and DONE once a result
-- has landed, win or lose. `src/storage/build-outbox.ts` is the only reader
-- and writer.
--
-- The index matches exactly what `claim` scans: the oldest PENDING row of a
-- given class. `lease_expires` is nullable because a PENDING row (never
-- claimed) and a DONE row (lease no longer relevant) both have no lease to
-- expire — only a CLAIMED row does.
CREATE TYPE "public"."build_request_state" AS ENUM('PENDING', 'CLAIMED', 'DONE');--> statement-breakpoint
CREATE TABLE "build_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"class" text NOT NULL,
	"request" jsonb NOT NULL,
	"state" "public"."build_request_state" DEFAULT 'PENDING' NOT NULL,
	"lease_expires" timestamp with time zone,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "build_requests_state_class_created_at_idx" ON "build_requests" USING btree ("state","class","created_at");
