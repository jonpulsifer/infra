/**
 * A rendered d2 diagram, collapsed until somebody asks for it.
 *
 * The diagrams live in `src/web/client/diagrams/` as `.d2` sources with their
 * `.svg` committed beside them, because neither this image build nor the wiki
 * build has d2 — `mise run docs:diagrams` is what regenerates them, and the
 * wiki serves the same files. A flow that is drawn once and read in both places
 * cannot disagree with itself.
 *
 * Collapsed by default because these screens are ledgers: the operator came for
 * the rows, and a diagram that pushes them below the fold is worse than one
 * behind a disclosure. Nothing derives its open-ness from state that arrives
 * later, so this is Radix's uncontrolled arm.
 *
 * **The theme it follows is the browser's, not this app's.** `--dark-theme`
 * bakes both palettes into one SVG behind a `prefers-color-scheme` query, and
 * an `<img>` element's document is its own — the `data-theme` this app stamps on
 * the root never reaches inside it. A reader on the OS theme sees the matching
 * one; a reader who has toggled away from it sees the diagram they toggled
 * away from. Fixing that means inlining the SVG and rewriting its media query
 * into a `[data-theme]` selector, which is a bundler change for a diagram
 * that stays legible either way.
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
  /** What the disclosure says when closed — a question, not a noun. */
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
        {/* Natural size inside its own scroller: scaling a diagram to this
            column is what makes its labels unreadable, and the page body must
            never be the thing that scrolls sideways. */}
        {/* The surface follows `prefers-color-scheme`, not this app's `dark`
            variant, because the diagram inside it does — see the note above.
            Matching the page instead would frame a light diagram in dark. */}
        <div className="overflow-x-auto border-t border-border bg-white p-4 [@media(prefers-color-scheme:dark)]:bg-[#1e1e2e]">
          {/* biome-ignore lint/performance/noImgElement: no framework image component here — same as ui/logo.tsx */}
          <img src={src} alt={alt} className="max-w-none" />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
