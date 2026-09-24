/**
 * The failure block: the reason code verbatim, the blame chip, whether the
 * previous release still serves, and the evidence persisted at failure.
 * Evidence is null when the failure never reached a platform.
 */
import { useState } from 'react';
import { reasonCovers } from '../../adapters/deploy/contract.ts';
import type { Diagnosis, DriftView } from '../../commands/views.ts';
import { Button } from '../ui/button.tsx';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../ui/collapsible.tsx';
import { LogPane, Notice } from './log-pane.tsx';
import { BlameChip } from './status.tsx';

export function DiagnosisPanel({
  diagnosis,
  previousReleaseServing,
  url,
}: {
  diagnosis: Diagnosis;
  previousReleaseServing: boolean;
  url: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <section className="overflow-hidden rounded-lg border border-destructive">
      <header className="flex flex-wrap items-center gap-2.5 bg-destructive-soft px-3.5 py-3">
        <span className="font-mono text-[13px] font-semibold text-destructive">
          {diagnosis.reason}
        </span>
        <BlameChip blame={diagnosis.blame} />
        <span className="text-[12.5px] text-subtle">
          {reasonCovers(diagnosis.reason)}
        </span>
      </header>

      <div className="flex flex-col gap-3 bg-card px-3.5 py-3.5">
        <p className="text-sm text-foreground">{diagnosis.detail}</p>

        {previousReleaseServing ? (
          <Notice>
            The previous release is still serving <code>{url}</code>. Nothing
            went down.
          </Notice>
        ) : null}

        {diagnosis.evidence === null ? null : (
          <Collapsible open={open} onOpenChange={setOpen}>
            <CollapsibleTrigger className="text-[11.5px] font-semibold uppercase tracking-[0.05em] text-muted-foreground hover:text-foreground">
              {open ? 'Hide' : 'Show'} what Spindrift found
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2">
              <LogPane
                lines={diagnosis.evidence.split('\n').map((text) => ({ text }))}
              />
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
    </section>
  );
}

/**
 * A live release that no longer matches what runs. With no `detail`, something
 * else is serving; with one, the platform refuses every reconcile and `detail`
 * is its own sentence. Nothing corrects drift automatically.
 */
export function DriftPanel({
  drift,
  url,
  onRedeploy,
  busy,
}: {
  drift: DriftView;
  url: string;
  onRedeploy?: () => void;
  busy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const refused = drift.detail !== null;

  return (
    <section className="overflow-hidden rounded-lg border border-warning/40">
      <header className="flex flex-wrap items-center gap-2.5 bg-warning-soft px-3.5 py-3">
        <span className="font-mono text-[13px] font-semibold text-warning">
          DRIFTED
        </span>
        <span className="text-[12.5px] text-subtle">
          {refused
            ? 'the platform is refusing to apply this release'
            : 'what is running is not what this release asked for'}
        </span>
        <span className="ml-auto text-[12.5px] text-subtle" title={drift.at}>
          since {drift.since}
        </span>
      </header>

      <div className="flex flex-col gap-3 bg-card px-3.5 py-3.5">
        <p className="text-sm text-foreground">
          {refused ? (
            <>
              This release reached Live and the platform has stopped accepting
              it since. Every reconcile is failing, so nothing new can roll out
              here until it is resolved — the last release that applied cleanly
              is what {url ? <code>{url}</code> : 'this Component'} is still
              serving.
            </>
          ) : (
            <>
              Something other than this release is serving{' '}
              {url ? <code>{url}</code> : 'this Component'}. Spindrift does not
              correct drift on its own; deploying again re-converges it.
            </>
          )}
        </p>

        {drift.observedDigest === null ? null : (
          <Notice label="Serving">
            <code>{drift.observedDigest}</code>
          </Notice>
        )}

        {drift.detail === null ? null : (
          <Collapsible open={open} onOpenChange={setOpen}>
            <CollapsibleTrigger className="text-[11.5px] font-semibold uppercase tracking-[0.05em] text-muted-foreground hover:text-foreground">
              {open ? 'Hide' : 'Show'} what the platform said
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2">
              <LogPane
                lines={drift.detail.split('\n').map((text) => ({ text }))}
              />
            </CollapsibleContent>
          </Collapsible>
        )}

        {onRedeploy === undefined ? null : (
          <div>
            <Button variant="outline" onClick={onRedeploy} disabled={busy}>
              {busy ? 'Deploying…' : 'Deploy again to re-converge'}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
