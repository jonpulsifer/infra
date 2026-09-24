/**
 * The one number a screen exists to say. `tone` colours only the value, and
 * `footnote` holds the breakdown or says the count is partial.
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
