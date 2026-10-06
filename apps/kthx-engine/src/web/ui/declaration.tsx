/**
 * The document a button is about to submit, shown beside it. Callers pass the
 * output of the function that does the work, so the preview cannot drift.
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
  title?: string;
  /** What is inside, in two or three words. */
  label: string;
  note?: ReactNode;
  /** What in here is not exact, and why. Absent means every field is. */
  caveat?: string;
  /** Already serialized by whatever produces it. */
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
