import { Search } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { Badge } from '../ui/badge.tsx';
import { Eyebrow } from '../ui/card.tsx';
import { cn } from '../ui/utils.ts';

export type ExplorerTone =
  | 'success'
  | 'warning'
  | 'destructive'
  | 'idle'
  | 'accent';

export interface ExplorerItem {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly status: string;
  readonly tone: ExplorerTone;
  readonly when?: string;
  readonly at?: string;
  /** Extra searchable text that does not need to be repeated in the row. */
  readonly search?: string;
  /** Marks a status whose work is still moving. */
  readonly active?: boolean;
}

export function ExplorerPageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
  readonly actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end gap-4">
      <div>
        <Eyebrow>{eyebrow}</Eyebrow>
        <h1 className="mt-1 text-3xl font-semibold tracking-[-0.035em]">
          {title}
        </h1>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
          {description}
        </p>
      </div>
      {actions ? <div className="ml-auto flex gap-2">{actions}</div> : null}
    </header>
  );
}

/**
 * The Object Explorer's durable seam: one stable list beside one inspector.
 *
 * Selection is deliberately local. Picking an object is inspection, not
 * navigation; callers put the durable detail route behind an explicit action
 * in the inspector. That keeps the list in place while a person compares rows.
 */
export function ObjectExplorer({
  items,
  filterPlaceholder,
  empty,
  initialId,
  renderInspector,
}: {
  readonly items: readonly ExplorerItem[];
  readonly filterPlaceholder: string;
  readonly empty: ReactNode;
  readonly initialId?: string;
  readonly renderInspector: (item: ExplorerItem) => ReactNode;
}) {
  const [filter, setFilter] = useState('');
  const [selectedId, setSelectedId] = useState(
    () => initialId ?? items[0]?.id ?? '',
  );
  const visible = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    if (!query) return items;
    return items.filter((item) =>
      `${item.title} ${item.detail} ${item.status} ${item.when ?? ''} ${item.search ?? ''}`
        .toLocaleLowerCase()
        .includes(query),
    );
  }, [filter, items]);
  const selected =
    visible.find((item) => item.id === selectedId) ?? visible[0] ?? null;

  if (items.length === 0) return <>{empty}</>;

  return (
    <div className="grid min-h-[620px] overflow-hidden rounded-sm border border-border bg-card shadow-[0_18px_55px_rgba(0,0,0,0.28)] md:grid-cols-[minmax(240px,320px)_minmax(0,1fr)]">
      <section
        aria-label="Objects"
        className="min-w-0 border-b border-border md:border-r md:border-b-0"
      >
        <label className="relative block border-b border-border p-3">
          <span className="sr-only">Filter objects</span>
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-6 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.currentTarget.value)}
            placeholder={filterPlaceholder}
            className="h-9 w-full rounded-sm border border-input bg-background pr-3 pl-9 text-sm text-foreground placeholder:text-muted-foreground"
          />
        </label>
        <div className="max-h-[520px] overflow-y-auto md:max-h-none">
          {visible.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-muted-foreground">
              Nothing matches “{filter}”.
            </p>
          ) : (
            visible.map((item) => {
              const isSelected = item.id === selected?.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => setSelectedId(item.id)}
                  className={cn(
                    'grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 border-b border-border-soft px-4 py-3.5 text-left transition-colors',
                    isSelected
                      ? 'bg-accent text-foreground shadow-[inset_3px_0_var(--accent)]'
                      : 'text-subtle hover:bg-secondary hover:text-foreground',
                  )}
                >
                  <strong className="truncate text-sm font-semibold">
                    {item.title}
                  </strong>
                  <Badge tone={item.tone} className="row-span-2 self-center">
                    <span
                      aria-hidden="true"
                      className={cn(
                        'size-1.5 rounded-full bg-current',
                        item.active && 'motion-safe:animate-pulse',
                      )}
                    />
                    {item.status}
                  </Badge>
                  <small className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                    <span className="truncate">{item.detail}</span>
                    {item.when ? (
                      <time
                        dateTime={item.at}
                        title={item.at}
                        className="ml-auto shrink-0 font-mono"
                      >
                        {item.when}
                      </time>
                    ) : null}
                  </small>
                </button>
              );
            })
          )}
        </div>
      </section>
      <article
        aria-label={selected ? `${selected.title} inspector` : 'Inspector'}
        className="min-w-0 bg-[color:var(--inspector)] p-5 sm:p-7"
      >
        {selected ? (
          renderInspector(selected)
        ) : (
          <p className="py-12 text-center text-sm text-muted-foreground">
            No matching object to inspect.
          </p>
        )}
      </article>
    </div>
  );
}

export function DefinitionGrid({
  entries,
}: {
  readonly entries: readonly {
    readonly label: string;
    readonly value: ReactNode;
    readonly mono?: boolean;
  }[];
}) {
  return (
    <dl className="mt-6 grid overflow-hidden rounded-sm border border-border sm:grid-cols-2 xl:grid-cols-3">
      {entries.map((entry) => (
        <div
          key={entry.label}
          className="min-w-0 border-b border-border-soft bg-secondary/35 p-4 last:border-b-0 sm:border-r sm:[&:nth-last-child(-n+2)]:border-b-0 xl:[&:nth-last-child(-n+3)]:border-b-0"
        >
          <dt className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
            {entry.label}
          </dt>
          <dd
            className={cn(
              'mt-1.5 truncate text-sm font-semibold text-foreground',
              entry.mono && 'font-mono',
            )}
          >
            {entry.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
