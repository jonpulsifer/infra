/**
 * A read that failed, said in full — and the button that retries it.
 *
 * Ten screens rendered a refusal as the same pasted div:
 * `rounded-lg border border-destructive/50 bg-destructive/10 p-4
 * text-destructive`, holding a message and nothing else. One of the ten had
 * already drifted to a different radius, which is the usual proof that a shape
 * is a component that has not been written yet.
 *
 * The missing piece was never the styling. A screen whose *load* failed has
 * nothing on it — no rows, no filter, no navigation of its own — so a sentence
 * with no retry leaves the reader with the browser's reload button as the only
 * affordance, and reloading a hash-routed app is a heavier act than re-running
 * one query. `CreationLoadFailure` in the create flow worked this argument
 * out first and grew the button; now every screen, that one included, renders
 * the shape through here.
 *
 * `code` is rendered rather than swallowed. A transport failure code is not
 * operator prose, but it is the string that makes a support conversation short,
 * and hiding it means the reader retypes an approximation of the sentence
 * instead. It sits in mono, small, beside the title — labelled as machine text
 * by its typeface rather than by an apology.
 *
 * `role="alert"`: unlike a toast, this replaced the content the reader asked
 * for, so it is worth interrupting to say so.
 */
import { RotateCcw, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './button.tsx';
import { cn } from './utils.ts';

export function ErrorState({
  title,
  code,
  message,
  onRetry,
  secondary,
  className,
}: {
  readonly title: string;
  /** The transport or domain code, when the failure carried one. */
  readonly code?: string;
  readonly message: ReactNode;
  readonly onRetry?: () => void;
  /** Another way out — back to the ledger, on to the docs. */
  readonly secondary?: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        'rounded-sm border border-destructive/50 bg-destructive-soft px-4 py-3.5',
        className,
      )}
    >
      <div className="flex items-center gap-2 text-destructive">
        <TriangleAlert className="size-4 shrink-0" />
        <p className="text-ui font-semibold">{title}</p>
        {code ? (
          <span className="font-mono text-caption text-muted-foreground">
            {code}
          </span>
        ) : null}
      </div>
      <p className="mt-1.5 text-body text-subtle">{message}</p>
      {onRetry || secondary ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {onRetry ? (
            <Button size="sm" variant="outline" onClick={onRetry}>
              <RotateCcw />
              Try again
            </Button>
          ) : null}
          {secondary}
        </div>
      ) : null}
    </div>
  );
}
