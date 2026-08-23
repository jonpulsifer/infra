/**
 * Button — the shadcn primitive, with this installation's palette.
 *
 * `asChild` is the one piece of Radix worth taking here: a link that looks like
 * a button should still be an `<a>`, and `Slot` merges the button's props onto
 * whatever child it is given rather than wrapping it. An `<a>` inside a
 * `<button>` is the alternative, and it is not focusable, not middle-clickable,
 * and not valid HTML.
 */
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from './utils.ts';

const button = cva(
  cn(
    'inline-flex items-center justify-center gap-2 whitespace-nowrap',
    // Feedback lands on the press, not on the release. A control that waits
    // for `click` to acknowledge a finger already on it reads as a control
    // that did not notice, and this is the one component every screen presses.
    'rounded-sm font-medium transition duration-100 ease-out',
    'active:scale-[0.97]',
    'disabled:pointer-events-none disabled:opacity-50',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:size-4',
  ),
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:opacity-90',
        outline:
          'border border-border bg-card text-subtle hover:border-primary hover:text-foreground',
        ghost: 'text-subtle hover:bg-secondary hover:text-foreground',
        destructive: 'bg-destructive text-background hover:opacity-90',
        link: 'text-accent-foreground underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-8 px-3 text-xs',
        default: 'h-9 px-4 text-sm',
        lg: 'h-10 px-5 text-sm',
        icon: 'size-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export type ButtonProps = ComponentProps<'button'> &
  VariantProps<typeof button> & { asChild?: boolean };

export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ButtonProps) {
  const Component = asChild ? Slot : 'button';
  return (
    <Component
      className={cn(button({ variant, size }), className)}
      {...props}
    />
  );
}
