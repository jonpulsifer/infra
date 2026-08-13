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
import { useEffect, useRef } from 'react';
import type { LogLine } from '../../commands/views.ts';
import { cn } from '../ui/utils.ts';

const TONE = {
  error: 'text-terminal-destructive',
  muted: 'text-terminal-muted',
} as const;

/**
 * How close to the bottom counts as "watching the end", in pixels.
 *
 * Generous, because the test is applied *after* the new lines are in the DOM:
 * a reader pinned to the bottom is already this far from it by the time the
 * effect runs, and a tighter threshold would drop them off the tail on exactly
 * the fast-moving logs that most need following.
 */
const FOLLOW_SLACK_PX = 120;

export function LogPane({
  lines,
  follow = false,
  className,
}: {
  lines: readonly LogLine[];
  /**
   * Keep the newest line in view as output arrives.
   *
   * Set while the thing writing the log is still running, and never otherwise —
   * a finished transcript is a document you read from the top. Following also
   * caps the pane's height, because a pane that grows forever has no bottom to
   * scroll to and would drag the whole page down instead.
   */
  follow?: boolean;
  className?: string;
}) {
  const pane = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const node = pane.current;
    if (!follow || node === null) return;
    // Only if the reader is already at the end. Somebody who scrolled up to
    // read an earlier line is reading it, and yanking them back to the tail
    // every time the runner prints is how a live log becomes unusable.
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    if (distance > FOLLOW_SLACK_PX) return;
    node.scrollTop = node.scrollHeight;
  }, [follow, lines]);

  return (
    <pre
      ref={pane}
      className={cn(
        'overflow-x-auto rounded-lg bg-terminal px-3.5 py-3',
        'text-[12.5px] leading-[1.65] text-terminal-foreground',
        follow && 'max-h-[420px] overflow-y-auto scroll-smooth',
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
 * The honest empty state (§17) now lives in `ui/empty-state.tsx`, where the
 * ledgers and the workspace can reach it without importing a log pane.
 *
 * Re-exported from here rather than moved, because "there is no output to
 * stream, and here is why" is the pane's own alternative — the argument at the
 * top of this file is what made the component exist — and every call site that
 * reads `EmptyState` out of the log module is reading it from the right place
 * for the reason it is used there.
 */
export { EmptyState } from '../ui/empty-state.tsx';
