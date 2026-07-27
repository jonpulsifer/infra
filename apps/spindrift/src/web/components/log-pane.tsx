/**
 * Machine output, on the one dark surface in the app.
 *
 * The terminal colours do not flip with the theme. A build log is a verbatim
 * transcript of something a machine printed, and re-tinting it in light mode
 * would be the UI editing evidence — the same reason §6 persists a diagnosis
 * rather than re-deriving it later.
 *
 * `Notice` is next to it because the two are alternatives: where there is no
 * log text, §4's `logFidelity` says why, and §18 requires that sentence rather
 * than an empty pane or a spinner.
 */
import type { ReactNode } from 'react';
import type { LogLine } from '../model.ts';
import { cn } from '../ui/utils.ts';

const TONE = {
  error: 'text-terminal-destructive',
  muted: 'text-terminal-muted',
} as const;

export function LogPane({
  lines,
  className,
}: {
  lines: readonly LogLine[];
  className?: string;
}) {
  return (
    <pre
      className={cn(
        'overflow-x-auto rounded-lg bg-terminal px-3.5 py-3',
        'text-[12.5px] leading-[1.65] text-terminal-foreground',
        className,
      )}
    >
      {lines.map((line, index) => (
        <span
          // Log lines repeat verbatim and arrive in order; position is the
          // only identity they have.
          key={index}
          className={line.tone ? TONE[line.tone] : undefined}
        >
          {line.text}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

/**
 * A short standing statement, marked with the accent rule.
 *
 * Used for the two sentences §18 makes load-bearing — "the checklist is the
 * live view" and "the previous release is still serving" — and for nothing
 * that could be a badge instead.
 */
export function Notice({
  tone = 'accent',
  label,
  children,
}: {
  tone?: 'accent' | 'destructive';
  label?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-2.5 rounded-r-md border-l-2 bg-secondary px-3 py-2.5',
        'text-[12.5px] text-subtle',
        tone === 'accent' ? 'border-l-primary' : 'border-l-destructive',
      )}
    >
      {label ? (
        <span
          className={cn(
            'shrink-0 font-mono font-semibold',
            tone === 'accent' ? 'text-accent-foreground' : 'text-destructive',
          )}
        >
          {label}
        </span>
      ) : null}
      <span>{children}</span>
    </div>
  );
}

/**
 * The honest empty state (§17).
 *
 * A `website` on a static Target has no process, so there is no output to
 * stream — and §17 is explicit that this gets a stated reason rather than a
 * disabled tab. Disabling hides the fact; this names it.
 */
export function EmptyState({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center">
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <p className="mt-1 text-[12.5px] text-muted-foreground">{children}</p>
    </div>
  );
}
