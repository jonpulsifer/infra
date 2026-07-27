/**
 * Badge — the one-word state marker, in the four tones the domain has.
 *
 * The tones are not a palette choice. §6 gives a deploy exactly one phase at a
 * time and the UI has to say which without being read: `success` is `LIVE`,
 * `warning` is in flight, `destructive` is `FAILED`, and `idle` is everything
 * that has not started. A fifth tone would mean the domain grew a fifth answer.
 */
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from './utils.ts';

const badge = cva(
  cn(
    'inline-flex items-center gap-1.5 rounded-md',
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

/**
 * The status dot. `pulse` marks a state that is still moving — and only that,
 * because a dot that always pulses stops meaning "still moving".
 *
 * This is the only animation in the app, so `motion-safe` is declared here
 * rather than as a global reduced-motion reset. A reader who asked for less
 * motion still gets the dot, and still gets the tone and the word beside it —
 * the animation was never the only thing saying "in flight".
 */
export function Dot({
  pulse = false,
  className,
  ...props
}: ComponentProps<'span'> & { pulse?: boolean }) {
  return (
    <span
      className={cn(
        'size-[7px] shrink-0 rounded-full bg-current',
        pulse && 'motion-safe:animate-pulse',
        className,
      )}
      {...props}
    />
  );
}
