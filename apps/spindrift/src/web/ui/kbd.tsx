/**
 * A key the reader is meant to press, drawn as a key.
 *
 * It exists because a shortcut nobody can see is a shortcut nobody uses: the
 * whole application contained one `onKeyDown` handler, and the moment there is a
 * palette on ⌘K there has to be somewhere for "⌘K" to be *shown* — in the hint
 * beside the search affordance, and in the palette's own rows.
 *
 * A real `<kbd>`, so the base stylesheet's monospace and tabular-nums rule
 * already applies and a screen reader announces it as keyboard input rather than
 * as a stray glyph. The caller supplies the glyph: this component has no opinion
 * about ⌘ versus Ctrl, because that is a fact about the reader's platform and
 * not about the shortcut.
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
