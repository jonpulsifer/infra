/**
 * Machine output on the app's one dark surface. The terminal colours ignore the
 * theme, because a log is a verbatim transcript.
 */
import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import type { LogLine } from '../../commands/views.ts';
import { cn } from '../ui/utils.ts';

const TONE = {
  error: 'text-terminal-destructive',
  muted: 'text-terminal-muted',
} as const;

// Generous, because the check runs after new lines are in the DOM, when a
// reader at the bottom is already this far from it.
const FOLLOW_SLACK_PX = 120;

export function LogPane({
  lines,
  follow = false,
  className,
}: {
  lines: readonly LogLine[];
  /**
   * Keep the newest line in view while the writer runs. Also caps the pane's
   * height, so it has a bottom to follow.
   */
  follow?: boolean;
  className?: string;
}) {
  const pane = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const node = pane.current;
    if (!follow || node === null) return;
    // Only when the reader is at the end, so a reader scrolled up stays put.
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
          // Lines repeat verbatim, so position is their only identity.
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

/** A short standing statement, marked with the accent rule. */
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

// Re-exported for callers that show it in place of a log.
export { EmptyState } from '../ui/empty-state.tsx';
