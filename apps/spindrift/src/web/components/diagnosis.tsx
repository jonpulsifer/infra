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
 * 4. **The evidence, collapsed.** §6 reads pods and events once on red and
 *    persists what it found, because the platform will not keep it. It is
 *    behind a disclosure because it is the second question, never the first.
 */
import { useState } from 'react';
import { reasonCovers } from '../../adapters/deploy/contract.ts';
import type { Diagnosis } from '../model.ts';
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
      </div>
    </section>
  );
}
