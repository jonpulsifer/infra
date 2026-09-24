/**
 * A tab strip with `role="tablist"` and a roving `tabIndex`. Arrowing selects
 * at once, which suits loaded data. No `aria-controls`, since no caller has one
 * panel.
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
  readonly label?: string;
  readonly className?: string;
}) {
  const strip = useRef<HTMLDivElement>(null);
  // Set only by an arrow press, so focus stays put on mount or a route change.
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
