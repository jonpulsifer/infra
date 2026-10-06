-- Clear the drift the observer wrote onto releases nobody desires any more.
--
-- `observeConverged` selected every Deploy at `phase = 'LIVE'`. A release a
-- newer intent superseded stays LIVE — the phase is the platform's verdict on
-- one attempt and is never edited afterwards — so every superseded release was
-- read back off its platform and compared against a Build that stopped being
-- desired the moment something newer landed. That is drift on every pass and
-- forever, and it accumulated one more permanently-drifted row per redeploy.
--
-- The observer now reads the release `component_target_desired` names, so
-- these rows will never be looked at again and would carry a finding nothing
-- can clear. The ledger reads them, so the finding has to go.
--
-- Scoped to rows that are *not* their pair's desired release: a genuinely
-- drifted current release keeps its finding, which is the one this fix is
-- meant to leave visible.
UPDATE deploys
SET drifted_at = NULL,
    observed_digest = NULL,
    drift_detail = NULL
WHERE drifted_at IS NOT NULL
  AND id NOT IN (
    SELECT desired_deploy_id
    FROM component_target_desired
    WHERE desired_deploy_id IS NOT NULL
  );
