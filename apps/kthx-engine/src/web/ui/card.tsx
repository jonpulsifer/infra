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

/** The uppercase micro-label above a value. */
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
