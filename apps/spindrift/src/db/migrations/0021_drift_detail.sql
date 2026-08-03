-- §6's drift is "detected and surfaced, never silently corrected", and the
-- surfacing was a flag plus the digest running instead. That pair cannot
-- describe the case this column exists for: a delivery object failing every
-- reconcile while the previous release keeps serving the digest that was asked
-- for. Nothing is running instead — nothing new is running at all.
--
-- Separate from `detail`, which belongs to a `FAILED` verdict. A Deploy in this
-- state reached `LIVE`; what changed is that the platform stopped agreeing.
ALTER TABLE "deploys" ADD COLUMN "drift_detail" text;
