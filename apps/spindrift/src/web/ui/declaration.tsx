/**
 * What a button is about to submit, shown before it is submitted.
 *
 * Every screen in here that creates something has the same problem: the act is
 * one press, and what leaves Spindrift because of it is a document — a manifest
 * entry, a `spindrift.yaml`, a Terraform block, a Kubernetes object. The press
 * is legible and the document is not, so the operator either trusts the button
 * or goes and reads the source. This is the third answer: the document, beside
 * the button, before the press.
 *
 * Two rules make it worth having rather than decorative.
 *
 * **The text must come from the function that does the work.** A view that
 * re-derives what it thinks will be submitted is a second implementation that
 * drifts, and a preview that drifts is worse than none — it is a lie the
 * operator has been taught to trust. Every caller passes the output of the same
 * pure function the server calls: `clusterConnectPlan`, `serializeSpindriftFile`,
 * `terraformRemediation`. Nothing is composed here.
 *
 * **What cannot be known says so.** Several payloads carry a value that does not
 * exist until the act happens — a bundle digest that staging mints, a Deploy id
 * the insert assigns. `caveat` is where that goes, and it is part of the shape
 * rather than an afterthought, because a declaration that quietly shows a
 * plausible number for one of those is the exact failure this is supposed to
 * prevent.
 *
 * JSON, where the payload is structured, because JSON is valid YAML and an
 * emitter would be a thing to maintain for output nobody parses back. Callers
 * with literal text — a file Spindrift writes verbatim — pass it through.
 *
 * Collapsed by default. It is the answer to "what exactly will this do", which
 * is a question asked before the first press and rarely after.
 */
import { type ReactNode, useState } from 'react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from './collapsible.tsx';
import { CopyButton } from './copy.tsx';

export function Declaration({
  title = 'Declaration',
  label,
  note,
  caveat,
  text,
}: {
  /** The disclosure's own name. Defaults to the one every caller wants. */
  title?: string;
  /** What is inside, in two or three words: `manifest entry`, `spindrift.yaml`. */
  label: string;
  /** What this document is, and what submitting it does — and does not — do. */
  note?: ReactNode;
  /** What in here is not exact, and why. Absent means every field is. */
  caveat?: string;
  /** The document itself, already serialized by whatever produces it. */
  text: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
        {title}
        <span className="ml-auto font-mono">{open ? 'hide' : label}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 flex flex-col gap-1.5">
        {note ? <p className="text-[11px] text-subtle">{note}</p> : null}
        <pre className="overflow-x-auto rounded-md border border-border bg-background px-3 py-2 font-mono text-[11px]">
          {text}
        </pre>
        {caveat ? <p className="text-[11px] text-warning">{caveat}</p> : null}
        <div>
          <CopyButton value={text} label={label} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
