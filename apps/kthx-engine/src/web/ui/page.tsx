/**
 * The three column widths and the page header. A skeleton and its content share
 * a width, so the page does not shift sideways when data arrives.
 */
import type { ReactNode } from 'react';
import { Eyebrow } from './card.tsx';
import { cn } from './utils.ts';

const WIDTH = {
  wide: 'max-w-[1320px]',
  reading: 'max-w-[1040px]',
  focus: 'max-w-[640px]',
} as const;

export function Page({
  width = 'wide',
  className,
  children,
}: {
  readonly width?: keyof typeof WIDTH;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'mx-auto flex w-full flex-col gap-6 px-5 py-8',
        WIDTH[width],
        className,
      )}
    >
      {children}
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  breadcrumb,
}: {
  readonly eyebrow?: ReactNode;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly breadcrumb?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end gap-4">
      <div className="min-w-0">
        {breadcrumb}
        {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
        <h1 className="mt-1 text-display font-semibold tracking-display">
          {title}
        </h1>
        {description ? (
          <p className="mt-1 max-w-2xl text-ui leading-6 text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="ml-auto flex flex-wrap gap-2">{actions}</div>
      ) : null}
    </header>
  );
}
