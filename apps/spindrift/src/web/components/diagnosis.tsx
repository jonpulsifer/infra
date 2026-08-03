/**
 * The red block: what failed, who it indicts, and what core actually saw.
 *
 * Four things in a fixed order, each of them settled rather than chosen:
 *
 * 1. **The reason, in the domain's own vocabulary.** §6's eight reasons are a
 *    closed set precisely so a failure has an identity a test can key on and a
 *    human can search for. Rewording `ARTIFACT_UNAVAILABLE` into friendlier
 *    prose would spend that.
 * 2. **The blame chip** (§18), which is what stops a developer debugging code
 *    that is fine.
 * 3. **The previous-release line**, when one is still up. §18: "the red screen
 *    says the previous release is still serving", and that "changed the feel of
 *    failure more than anything else". §6 guarantees it is true — exposure is
 *    never mutated by a failed deploy.
 * 4. **The evidence, collapsed** — and only when there is some. §6 reads pods
 *    and events once on red and persists what it found, because the platform
 *    will not keep it. It is behind a disclosure because it is the second
 *    question, never the first. A failure core decided for itself never reached
 *    a platform to read, so `evidence` is null and the disclosure is absent:
 *    offering "show what Spindrift found" over an empty pane promises an answer
 *    that was never recorded.
 */
import { useState } from 'react';
import { reasonCovers } from '../../adapters/deploy/contract.ts';
import type { Diagnosis, DriftView } from '../model.ts';
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
 * The amber block: a release that succeeded and no longer agrees with reality.
 *
 * Deliberately not the red one. §6 calls drift "information, not an alarm", and
 * on this screen the distinction is load-bearing — a red panel over a release
 * that is still serving traffic would say an outage that is not happening.
 *
 * The two arms it renders are the two ways a converged release stops being
 * converged, and they want opposite first sentences. A digest mismatch means
 * **something else is serving**: somebody applied around Spindrift, and the
 * question is which artifact won. A refusal means **nothing new can serve at
 * all**: the delivery object is failing every reconcile behind a previous
 * release that is still up, so the App looks fine and has been frozen since.
 * That second arm is the one nothing surfaced before — it has no digest to
 * report, because no new digest ever landed — and it is the reason `detail`
 * carries the platform's own sentence rather than a phrase composed here. The
 * sentence names the value the chart rejected; a paraphrase would not.
 *
 * The button is §6's "one-click re-converge", and it is the same redeploy act
 * as everywhere else — drift is never corrected on Spindrift's own initiative,
 * so the affordance is a person pressing the ordinary path.
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
