/**
 * One number a screen exists to say, at the size that says it.
 *
 * The landing screen's four tiles were four hand-built cards with the count in
 * `text-3xl` and the breakdown in a hand-coloured sentence beneath. Two problems
 * came with that, and only one of them is visual. The tiles were inert: the
 * number told the reader that three things need attention and left them to find
 * which three in the feed below. And a page-size total was presented as a fleet
 * total, because the tile counted the array it was handed.
 *
 * So `onClick` is here in the primitive rather than added per tile later — a
 * metric that can name a subset should be able to *show* that subset, and the
 * hover and focus affordances only exist when it can. `footnote` is where the
 * breakdown or the honesty goes ("the newest 12"), because a count that is not
 * the whole truth has to say so next to itself, not in a caption further down.
 *
 * `tone` colours the value only. A whole tile tinted red reads as a broken tile
 * rather than as a count of broken things, and four tinted tiles read as an
 * emergency in a product whose ordinary steady state includes one failing App.
 */
import type { ReactNode } from 'react';
import { Eyebrow } from './card.tsx';
import { cn } from './utils.ts';

export type MetricTone = 'idle' | 'success' | 'warning' | 'destructive';

const TONE = {
  idle: 'text-foreground',
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
} as const satisfies Record<MetricTone, string>;

export function Metric({
  label,
  value,
  tone = 'idle',
  footnote,
  onClick,
  className,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly tone?: MetricTone;
  readonly footnote?: ReactNode;
  readonly onClick?: () => void;
  readonly className?: string;
}) {
  const body = (
    <>
      <Eyebrow>{label}</Eyebrow>
      <p
        className={cn(
          'mt-1.5 text-display font-semibold tracking-display tabular-nums',
          TONE[tone],
        )}
      >
        {value}
      </p>
      {footnote ? (
        <p className="mt-2 text-caption text-muted-foreground">{footnote}</p>
      ) : null}
    </>
  );

  const frame = 'rounded-sm border border-border bg-card px-4 py-3.5';

  if (!onClick) {
    return <div className={cn(frame, className)}>{body}</div>;
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        frame,
        'text-start transition-colors hover:border-primary',
        className,
      )}
    >
      {body}
    </button>
  );
}
