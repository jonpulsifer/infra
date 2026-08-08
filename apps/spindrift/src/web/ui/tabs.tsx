/**
 * One strip of tabs, replacing the three the tree had grown.
 *
 * There were three: boxed pills in a bordered box on the supply-chain header,
 * round chips on the landing screen, and a bordered segment in the settings
 * rail. All three were `<button>` elements carrying `aria-current="page"` — which
 * is a claim about *navigation*, and two of the three did not navigate. They set
 * a filter. A screen reader was told the current page was "In-Flight (2)".
 *
 * So this is `role="tablist"` with `aria-selected`, and the `line` variant is the
 * default because an underline is the one tab shape that reads as "these are
 * views of the thing below" rather than as "these are buttons". `pill` stays for
 * a filter strip, where the segments are peers of each other and not of a
 * heading.
 *
 * The keyboard behaviour is the part that is easy to skip and impossible to work
 * around: a roving `tabIndex` so Tab enters the strip once instead of stopping on
 * every tab, arrows to move within it, and focus following the arrow rather than
 * lagging on the tab that was pressed. Activation is automatic — arrowing selects
 * — which is correct for tabs whose panels are already loaded and wrong for tabs
 * that fetch. Every consumer here has its data in hand.
 *
 * It does not own a panel. `aria-controls` is deliberately absent: the callers
 * are route-driven or filter-driven and there is no single element these tabs
 * describe, and a dangling `aria-controls` is worse than none.
 */
import { useEffect, useRef } from 'react';
import { cn } from './utils.ts';

export interface TabItem {
  readonly id: string;
  readonly label: string;
  readonly count?: number;
}

export function Tabs({
  items,
  current,
  onSelect,
  variant = 'line',
  label,
  className,
}: {
  readonly items: readonly TabItem[];
  readonly current: string;
  readonly onSelect: (id: string) => void;
  readonly variant?: 'line' | 'pill';
  /** What this strip switches between, for anyone who cannot see the heading. */
  readonly label?: string;
  readonly className?: string;
}) {
  const strip = useRef<HTMLDivElement>(null);
  // Set only by an arrow press, so the strip never grabs focus on mount or when
  // a route change moves the selection.
  const moved = useRef(false);

  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    const index = items.findIndex((item) => item.id === current);
    const node = strip.current?.children[index];
    if (node instanceof HTMLElement) node.focus();
  }, [current, items]);

  const step = (delta: number, from: number) => {
    const next = items[Math.min(items.length - 1, Math.max(0, from + delta))];
    if (!next || next.id === current) return;
    moved.current = true;
    onSelect(next.id);
  };

  return (
    <div
      ref={strip}
      role="tablist"
      aria-label={label}
      className={cn(
        'flex flex-wrap items-center',
        variant === 'line' ? 'gap-4 border-b border-border' : 'gap-1.5',
        className,
      )}
    >
      {items.map((item, index) => {
        const selected = item.id === current;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(item.id)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight') {
                event.preventDefault();
                step(1, index);
              } else if (event.key === 'ArrowLeft') {
                event.preventDefault();
                step(-1, index);
              } else if (event.key === 'Home') {
                event.preventDefault();
                step(-items.length, index);
              } else if (event.key === 'End') {
                event.preventDefault();
                step(items.length, index);
              }
            }}
            className={cn(
              'inline-flex items-center gap-1.5 text-body font-semibold transition-colors',
              variant === 'line'
                ? cn(
                    '-mb-px border-b-2 px-0.5 pb-2.5',
                    selected
                      ? 'border-primary text-foreground'
                      : 'border-transparent text-muted-foreground hover:text-foreground',
                  )
                : cn(
                    'rounded-full px-3 py-1.5',
                    selected
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                  ),
            )}
          >
            {item.label}
            {item.count === undefined ? null : (
              <span className="tabular-nums text-muted-foreground">
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
