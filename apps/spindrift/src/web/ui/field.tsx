/**
 * The form atoms: a label, a text input, and the pairing of the two.
 *
 * `Field` exists so that no screen writes a label and an input that are not
 * associated — the `htmlFor`/`id` pair is generated from one `name` prop, so
 * forgetting it is not a shape this component can be called in.
 *
 * `Label` is Radix's rather than a bare `<label>`, which is what shadcn uses
 * and what the lint rule is asking for. The behaviour worth having is small and
 * annoying to reproduce: it suppresses the text selection a double-click on a
 * label otherwise causes, so clicking twice at a field focuses it instead of
 * highlighting its caption.
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
  /**
   * What is wrong with the value, said here rather than at the bottom of the
   * page.
   *
   * A rule the form already knows is a rule the form can state where the value
   * is: a transport refusal listing `appName` under a Deploy button is the same
   * fact delivered where nobody can act on it. `aria-invalid` carries it to
   * anyone not reading the sentence.
   */
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
