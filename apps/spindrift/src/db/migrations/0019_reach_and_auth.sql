CREATE TYPE "reach_state" AS ENUM ('none', 'private', 'public');
--> statement-breakpoint
CREATE TYPE "auth_mode" AS ENUM ('none', 'proxy');
--> statement-breakpoint
ALTER TABLE "components" ADD COLUMN "reach" "reach_state" NOT NULL DEFAULT 'private';
--> statement-breakpoint
ALTER TABLE "components" ADD COLUMN "auth" "auth_mode" NOT NULL DEFAULT 'proxy';
--> statement-breakpoint
ALTER TABLE "deploys" ADD COLUMN "reach" "reach_state";
--> statement-breakpoint
ALTER TABLE "deploys" ADD COLUMN "auth" "auth_mode";
--> statement-breakpoint
UPDATE "components" SET
  "reach" = CASE "exposure"
    WHEN 'internal' THEN 'none'
    WHEN 'private' THEN 'private'
    WHEN 'public' THEN 'public'
  END::"reach_state",
  "auth" = CASE "exposure"
    WHEN 'internal' THEN 'none'
    WHEN 'private' THEN 'proxy'
    WHEN 'public' THEN 'none'
  END::"auth_mode";
--> statement-breakpoint
UPDATE "deploys" SET
  "reach" = CASE "exposure"
    WHEN 'internal' THEN 'none'
    WHEN 'private' THEN 'private'
    WHEN 'public' THEN 'public'
  END::"reach_state",
  "auth" = CASE "exposure"
    WHEN 'internal' THEN 'none'
    WHEN 'private' THEN 'proxy'
    WHEN 'public' THEN 'none'
  END::"auth_mode"
WHERE "exposure" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "components" DROP COLUMN "exposure";
--> statement-breakpoint
ALTER TABLE "deploys" DROP COLUMN "exposure";
--> statement-breakpoint
ALTER TABLE "targets" ADD COLUMN "reaches" "reach_state"[];
--> statement-breakpoint
ALTER TABLE "targets" ADD COLUMN "auth_reaches" "reach_state"[];
--> statement-breakpoint
-- `public_exposure` asserted one thing: a tunnel exists. That widens to every
-- reach. It said nothing when false or null, and `reaches` says nothing the same
-- way — left null, so the adapter's own floor applies rather than a guess.
UPDATE "targets"
  SET "reaches" = ARRAY['none', 'private', 'public']::"reach_state"[]
  WHERE "public_exposure" IS TRUE;
--> statement-breakpoint
ALTER TABLE "targets" DROP COLUMN "public_exposure";
--> statement-breakpoint
DROP TYPE "exposure_state";
