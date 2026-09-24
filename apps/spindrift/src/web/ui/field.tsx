/**
 * Form atoms. `Field` derives `htmlFor` and `id` from one `name`, and Radix's
 * `Label` keeps a double-click from selecting the caption.
 */
import { Root as LabelRoot } from '@radix-ui/react-label';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from './utils.ts';

export function Label({
  className,
  ...props
}: ComponentProps<typeof LabelRoot>) {
  return (
    <LabelRoot
      className={cn(
        'text-caption font-semibold uppercase tracking-eyebrow text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'h-9 w-full rounded-sm border border-input bg-background px-3',
        'font-mono text-body text-foreground',
        'placeholder:text-muted-foreground',
        'disabled:cursor-not-allowed disabled:opacity-60',
        className,
      )}
      {...props}
    />
  );
}

export function Field({
  name,
  label,
  hint,
  issue,
  className,
  children,
  ...props
}: Omit<ComponentProps<'input'>, 'children'> & {
  name: string;
  label: string;
  hint?: string;
  /** Shown under the input, which it marks `aria-invalid`. */
  issue?: string | null;
  children?: ReactNode;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={name}>{label}</Label>
      {children ?? (
        <Input
          id={name}
          name={name}
          aria-invalid={issue ? true : undefined}
          aria-describedby={issue ? `${name}-issue` : undefined}
          className={issue ? 'border-destructive' : undefined}
          {...props}
        />
      )}
      {issue ? (
        <p id={`${name}-issue`} className="text-xs text-destructive">
          {issue}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
