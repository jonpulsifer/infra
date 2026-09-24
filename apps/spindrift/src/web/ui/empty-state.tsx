/**
 * An empty view with its reason, and the way out when there is one. The reason
 * is `children`, so it can hold a link.
 */
import type { ReactNode } from 'react';
import { cn } from './utils.ts';

export type EmptyTone = 'idle' | 'accent' | 'warning' | 'success';

const TONE = {
  idle: 'border-border text-foreground',
  accent: 'border-primary/40 text-accent-foreground',
  warning: 'border-warning/50 text-warning',
  success: 'border-success/40 text-success',
} as const satisfies Record<EmptyTone, string>;

export function EmptyState({
  icon,
  title,
  children,
  action,
  tone = 'idle',
  className,
}: {
  readonly icon?: ReactNode;
  readonly title: string;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
  readonly tone?: EmptyTone;
  readonly className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center rounded-lg border border-dashed px-4 py-6 text-center',
        TONE[tone],
        className,
      )}
    >
      {icon ? (
        <span aria-hidden="true" className="mb-2 [&_svg]:size-5 opacity-70">
          {icon}
        </span>
      ) : null}
      <p className="text-ui font-semibold">{title}</p>
      {children ? (
        <p className="mt-1 text-body text-muted-foreground">{children}</p>
      ) : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}
