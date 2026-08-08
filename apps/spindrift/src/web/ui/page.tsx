/**
 * The three column widths this product has, and the one page header.
 *
 * There were three competing templates in the tree — `max-w-[1040px]` at 23
 * sites, `max-w-[1320px]` at 9, and a 640px wizard column — paired with three
 * different title sizes (`text-3xl`, `text-2xl`, `text-[27px]`). The visible
 * cost is not the inconsistency: six screens *load* at the reading width and
 * *land* at the wide one, so arriving anywhere shifts the whole page sideways
 * once the data comes back. Naming the widths is what lets a screen's skeleton
 * and its content agree.
 *
 * `wide` is a ledger — a table wants the room. `reading` is a screen of prose
 * and cards, where a full-width line of body text is unreadable. `focus` is one
 * decision at a time: the wizard, the gate, a create flow.
 *
 * No `Page` variant sets a background, a border, or vertical rhythm between its
 * children. A page is a width and a gutter; everything else is the screen's.
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

/**
 * The header every screen writes, in the order a reader needs it.
 *
 * `breadcrumb` sits above the eyebrow rather than replacing it: the crumb says
 * where this is, the eyebrow says what kind of thing it is, and a screen that
 * has both should not have to choose. Only `title` is required, because a
 * screen with nothing to add should say nothing rather than pad the slot.
 */
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
