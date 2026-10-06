-- An App's opt-in to Deploy-on-push (§15).
--
-- `false` and NOT NULL: auto-deploy is a developer turning something on, never
-- a default an App wakes up with because Spindrift shipped a migration.
ALTER TABLE "apps" ADD COLUMN "auto_deploy" boolean DEFAULT false NOT NULL;
