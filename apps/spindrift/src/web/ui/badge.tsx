/**
 * The one-word state marker. `success` is live, `warning` in flight,
 * `destructive` failed and `idle` not started.
 */
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from './utils.ts';

const badge = cva(
  cn(
    'inline-flex items-center gap-1.5 rounded-full',
    'px-2 py-1 text-[11.5px] font-semibold uppercase leading-none tracking-[0.04em]',
  ),
  {
    variants: {
      tone: {
        success: 'bg-success-soft text-success',
        warning: 'bg-warning-soft text-warning',
        destructive: 'bg-destructive-soft text-destructive',
        idle: 'bg-secondary text-muted-foreground',
        accent: 'bg-accent text-accent-foreground',
      },
    },
    defaultVariants: { tone: 'idle' },
  },
);

export type BadgeProps = ComponentProps<'span'> & VariantProps<typeof badge>;

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badge({ tone }), className)} {...props} />;
}

/** `pulse` marks a state in flight, and `hollow` one where nothing has run. */
export function Dot({
  pulse = false,
  hollow = false,
  className,
  ...props
}: ComponentProps<'span'> & { pulse?: boolean; hollow?: boolean }) {
  return (
    <span
      className={cn(
        'size-[7px] shrink-0 rounded-full',
        hollow ? 'border border-current bg-transparent' : 'bg-current',
        pulse && 'motion-safe:animate-pulse',
        className,
      )}
      {...props}
    />
  );
}
