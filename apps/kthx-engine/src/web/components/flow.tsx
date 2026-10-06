/**
 * A d2 diagram behind a disclosure, collapsed by default. Each `.svg` is
 * committed beside its `.d2` source; `mise run docs:diagrams` regenerates them.
 */
import { ChevronRight } from 'lucide-react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../ui/collapsible.tsx';

export function Flow({
  src,
  label,
  alt,
}: {
  readonly src: string;
  /** The closed disclosure's text, phrased as a question. */
  readonly label: string;
  readonly alt: string;
}) {
  return (
    <Collapsible className="rounded-sm border border-border bg-card">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight
          aria-hidden="true"
          className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-90"
        />
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent>
        {/* Natural size in its own scroller, since a scaled diagram's labels
            are unreadable. */}
        {/* The SVG follows `prefers-color-scheme`, since the app's `data-theme`
            never reaches inside an `<img>`, so the surface follows it too. */}
        <div className="overflow-x-auto border-t border-border bg-white p-4 [@media(prefers-color-scheme:dark)]:bg-[#1e1e2e]">
          {/* biome-ignore lint/performance/noImgElement: no framework image component here — same as ui/logo.tsx */}
          <img src={src} alt={alt} className="max-w-none" />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
