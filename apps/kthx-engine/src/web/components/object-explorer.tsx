/**
 * A list beside an inspector: `ObjectExplorer` for mixed rows, `LedgerExplorer`
 * for a sortable table. Selecting a row inspects it without navigating, and the
 * selection survives a filter that hides its row.
 */
import { Search } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '../ui/badge.tsx';
import { Button } from '../ui/button.tsx';
import { Eyebrow } from '../ui/card.tsx';
import { type Column, DataTable, rowKeyboard } from '../ui/data-table.tsx';
import { EmptyState } from '../ui/empty-state.tsx';
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
  /** Searchable text the row does not show. */
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
        <h1 className="mt-1 text-display font-semibold tracking-display">
          {title}
        </h1>
        <p className="mt-1 max-w-2xl text-body leading-6 text-muted-foreground">
          {description}
        </p>
      </div>
      {actions ? <div className="ml-auto flex gap-2">{actions}</div> : null}
    </header>
  );
}

/** One accessible name on every screen, so a reader knows it is one control. */
function FilterField({
  value,
  onChange,
  placeholder,
}: {
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly placeholder: string;
}) {
  return (
    <label className="relative block border-b border-border p-3">
      <span className="sr-only">Filter objects</span>
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-6 size-3.5 -translate-y-1/2 text-muted-foreground"
      />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={placeholder}
        className="h-9 w-full rounded-sm border border-input bg-background pr-3 pl-9 text-body text-foreground placeholder:text-muted-foreground"
      />
    </label>
  );
}

function NoMatch({ filter, onClear }: { filter: string; onClear: () => void }) {
  return (
    <EmptyState
      tone="warning"
      title={`Nothing matches “${filter}”.`}
      action={
        <Button variant="outline" onClick={onClear}>
          Clear filter
        </Button>
      }
      className="m-4 border-0"
    >
      Every row is still loaded — only this filter is hiding them.
    </EmptyState>
  );
}

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
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  // Set only by an arrow press, so the effect below never steals focus on
  // mount or when a poll replaces the rows under the reader.
  const moved = useRef(false);

  const visible = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    if (!query) return items;
    return items.filter((item) =>
      `${item.title} ${item.detail} ${item.status} ${item.when ?? ''} ${item.search ?? ''}`
        .toLocaleLowerCase()
        .includes(query),
    );
  }, [filter, items]);

  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    const node = list.current?.children[active];
    if (node instanceof HTMLElement) node.focus();
  }, [active]);

  const selected =
    items.find((item) => item.id === selectedId) ?? visible[0] ?? null;
  const hidden =
    selected !== null && !visible.some((item) => item.id === selected.id);

  const onKeyDown = rowKeyboard({
    count: visible.length,
    active,
    onActive: (next) => {
      moved.current = true;
      setActive(next);
    },
    onActivate: (index) => {
      const item = visible[index];
      if (item) setSelectedId(item.id);
    },
  });

  if (items.length === 0) return <>{empty}</>;

  return (
    <div className="grid overflow-hidden rounded-sm border border-border bg-card shadow-panel md:grid-cols-[minmax(240px,320px)_minmax(0,1fr)]">
      <section
        aria-label="Objects"
        className="min-w-0 border-b border-border md:border-r md:border-b-0"
      >
        <FilterField
          value={filter}
          onChange={setFilter}
          placeholder={filterPlaceholder}
        />
        <div
          ref={list}
          className="max-h-[70dvh] overflow-y-auto md:max-h-[calc(70dvh-3.5rem)]"
        >
          {visible.length === 0 ? (
            <NoMatch filter={filter} onClear={() => setFilter('')} />
          ) : (
            visible.map((item, index) => {
              const isSelected = item.id === selected?.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={isSelected}
                  tabIndex={index === active ? 0 : -1}
                  onFocus={() => setActive(index)}
                  onKeyDown={onKeyDown}
                  onClick={() => {
                    setActive(index);
                    setSelectedId(item.id);
                  }}
                  className={cn(
                    'grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 border-b border-border-soft px-4 py-3.5 text-left transition-colors',
                    // The panel clips at its edge, cutting an outset ring.
                    'focus-visible:-outline-offset-2',
                    isSelected
                      ? 'bg-accent text-foreground shadow-[inset_3px_0_var(--accent)]'
                      : 'text-subtle hover:bg-secondary hover:text-foreground',
                  )}
                >
                  <strong className="truncate text-body font-semibold">
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
                  <small className="flex min-w-0 items-center gap-2 text-caption text-muted-foreground">
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
        className="min-w-0 bg-inspector p-5 sm:p-7"
      >
        {hidden ? (
          <p className="mb-4 rounded-sm border border-warning/50 px-3 py-2 text-caption text-warning">
            Still inspecting {selected?.title} — the filter hides its row.
          </p>
        ) : null}
        {selected ? (
          renderInspector(selected)
        ) : (
          <p className="py-12 text-center text-body text-muted-foreground">
            No matching object to inspect.
          </p>
        )}
      </article>
    </div>
  );
}

/** The same two panes with the list as a table, for rows of like records. */
export function LedgerExplorer<T>({
  columns,
  rows,
  rowKey,
  rowSearch,
  filterPlaceholder,
  caption,
  empty,
  inspectorLabel,
  renderInspector,
}: {
  readonly columns: readonly Column<T>[];
  readonly rows: readonly T[];
  readonly rowKey: (row: T) => string;
  /** Everything a filter should match, including facts no column shows. */
  readonly rowSearch: (row: T) => string;
  readonly filterPlaceholder: string;
  readonly caption: string;
  readonly empty: ReactNode;
  readonly inspectorLabel: (row: T) => string;
  readonly renderInspector: (row: T) => ReactNode;
}) {
  const [filter, setFilter] = useState('');
  const [selectedKey, setSelectedKey] = useState(() =>
    rows[0] ? rowKey(rows[0]) : '',
  );

  const visible = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    if (!query) return rows;
    return rows.filter((row) =>
      rowSearch(row).toLocaleLowerCase().includes(query),
    );
  }, [filter, rows, rowSearch]);

  const selected =
    rows.find((row) => rowKey(row) === selectedKey) ?? visible[0] ?? null;
  const hidden =
    selected !== null &&
    !visible.some((row) => rowKey(row) === rowKey(selected));

  if (rows.length === 0) return <>{empty}</>;

  return (
    <div className="grid overflow-hidden rounded-sm border border-border bg-card shadow-panel xl:grid-cols-[minmax(0,1fr)_minmax(320px,26rem)]">
      <section
        aria-label="Objects"
        className="min-w-0 border-b border-border xl:border-r xl:border-b-0"
      >
        <FilterField
          value={filter}
          onChange={setFilter}
          placeholder={filterPlaceholder}
        />
        {visible.length === 0 ? (
          <NoMatch filter={filter} onClear={() => setFilter('')} />
        ) : (
          <div className="max-h-[70dvh] overflow-y-auto">
            <DataTable
              columns={columns}
              rows={visible}
              rowKey={rowKey}
              caption={caption}
              selectedKey={selected ? rowKey(selected) : undefined}
              onRowSelect={(row) => setSelectedKey(rowKey(row))}
            />
          </div>
        )}
      </section>
      <article
        aria-label={
          selected ? `${inspectorLabel(selected)} inspector` : 'Inspector'
        }
        className="min-w-0 bg-inspector p-5 sm:p-6"
      >
        {hidden ? (
          <p className="mb-4 rounded-sm border border-warning/50 px-3 py-2 text-caption text-warning">
            Still inspecting {selected ? inspectorLabel(selected) : ''} — the
            filter hides its row.
          </p>
        ) : null}
        {selected ? (
          renderInspector(selected)
        ) : (
          <p className="py-12 text-center text-body text-muted-foreground">
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
    /** The untruncated value, when the rendered one is an abbreviation. */
    readonly title?: string;
  }[];
}) {
  return (
    <dl className="mt-6 grid overflow-hidden rounded-sm border border-border sm:grid-cols-2">
      {entries.map((entry) => (
        <div
          key={entry.label}
          className="min-w-0 border-b border-border-soft bg-secondary/35 p-4 last:border-b-0 sm:border-r sm:[&:nth-last-child(-n+2)]:border-b-0"
        >
          <dt className="text-micro font-semibold uppercase tracking-eyebrow text-muted-foreground">
            {entry.label}
          </dt>
          {/* Every value truncates, so the title holds it whole. */}
          <dd
            title={
              entry.title ??
              (typeof entry.value === 'string' ? entry.value : undefined)
            }
            className={cn(
              'mt-1.5 truncate text-body font-semibold text-foreground',
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
