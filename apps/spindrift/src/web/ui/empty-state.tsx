/**
 * Nothing here, and why — with the way out when there is one.
 *
 * This is the promotion of `components/log-pane.tsx`'s `EmptyState`, whose
 * comment already argued the load-bearing half: a `website` on a static Target
 * has no process, so §17 requires the stated reason rather than a disabled tab
 * or an empty pane. That component is now this one, re-exported from where it
 * was so no importer changes.
 *
 * The two things it gained are the two the screens kept hand-rolling around it.
 * An `icon`, because an empty ledger and an empty filter result look identical
 * in prose and different at a glance. And an `action`, because half of these
 * states are reachable only by an act — "clear the filter", "connect a Target" —
 * and the reader had to find that control somewhere else on the page.
 *
 * `tone` is not decoration either: an empty list is `idle` and expected, while a
 * list emptied by a filter the reader forgot they set is `warning`. Refusing to
 * distinguish them is how "no results" reads as "no data".
 *
 * What it refuses: an illustration slot, a variant that fills the viewport, and
 * a `description` prop. The sentence is `children` so a screen can put a link in
 * it, which is what the honest reasons usually need.
 */
import type { ReactNode } from 'react';
import { cn } from './utils.ts';

export type EmptyTone = 'idle' | 'accent' | 'warning' | 'success';

const TONE = {
  idle: 'border-border text-foreground',
  accent: 'border-primary/40 text-accent-foreground',
  warning: 'border-warning/50 text-warning',
  success: 'border-success/40 text-success',
} as const satisfies Record<EmptyTone, string>;

export function EmptyState({
  icon,
  title,
  children,
  action,
  tone = 'idle',
  className,
}: {
  readonly icon?: ReactNode;
  readonly title: string;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
  readonly tone?: EmptyTone;
  readonly className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center rounded-lg border border-dashed px-4 py-6 text-center',
        TONE[tone],
        className,
      )}
    >
      {icon ? (
        <span aria-hidden="true" className="mb-2 [&_svg]:size-5 opacity-70">
          {icon}
        </span>
      ) : null}
      <p className="text-ui font-semibold">{title}</p>
      {children ? (
        <p className="mt-1 text-body text-muted-foreground">{children}</p>
      ) : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}
