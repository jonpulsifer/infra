/**
 * A key the reader is meant to press. The caller supplies the glyph, since the
 * modifier depends on the reader's platform.
 */
import type { ReactNode } from 'react';
import { cn } from './utils.ts';

export function Kbd({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-sm',
        'border border-border bg-secondary px-1.5',
        'text-micro font-semibold text-muted-foreground',
        className,
      )}
    >
      {children}
    </kbd>
  );
}
