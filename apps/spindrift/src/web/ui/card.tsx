/**
 * Card — a bordered surface, and the only container with a border in the app.
 *
 * The prototypes settled one radius, one border weight, and one surface colour
 * for every panel on every screen; nesting a card in a card was tried and read
 * as noise. So this stays deliberately dumb — no elevation prop, no tone prop,
 * no padding scale. A screen that wants a different density passes it at the
 * call site.
 */
import type { ComponentProps } from 'react';
import { cn } from './utils.ts';

export function Card({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('rounded-sm border border-border bg-card', className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex items-start gap-3 px-4 pt-4 pb-2', className)}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: ComponentProps<'h2'>) {
  return (
    <h2
      className={cn('text-base font-semibold tracking-tight', className)}
      {...props}
    />
  );
}

export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('px-4 pt-2 pb-4', className)} {...props} />;
}

/**
 * The uppercase micro-label above a value.
 *
 * It appears on every screen in the prototypes and is load-bearing on one of
 * them: §18's "the live checklist must be labelled as the live view" is this
 * element doing that job, which is why it is a component rather than a class
 * somebody retypes.
 */
export function Eyebrow({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      className={cn(
        'text-micro font-semibold uppercase tracking-eyebrow text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}
