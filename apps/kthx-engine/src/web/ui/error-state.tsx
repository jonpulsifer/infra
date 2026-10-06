/**
 * A failed read with a retry button. It has `role="alert"` because it replaces
 * the content the reader asked for.
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
  /** Another way out, such as a link back to the ledger. */
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
