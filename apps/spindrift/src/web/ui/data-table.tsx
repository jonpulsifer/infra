/**
 * Rows of facts, as a table — because that is what they are.
 *
 * Four ledger screens (Builds, Deploys, Sources, Artifacts) rendered the same
 * four-slot row: a title, one `detail` string with every other fact flattened
 * into it by `·`, a status word, and a time. The tree contained zero `<table>`
 * elements. That flattening is what makes a ledger unreadable — a column of
 * commits is scannable and `a1b2c3d · service · Cloud Build · sha256:…` is not,
 * and it is also why those screens could not offer sorting: there was nothing to
 * sort by, only a sentence.
 *
 * Sorting is client-side and unapologetic about it. Every one of these screens
 * already holds its full page of rows in memory (the server paginates by
 * `before`, and the ledger asks for the next page explicitly), so a round trip
 * to reorder twelve rows would be a network request to answer a question the
 * browser can answer. When a screen grows past what it can hold, the sort
 * belongs in the query and this component should be *given* the order rather
 * than growing a mode.
 *
 * What it refuses: column resizing, column hiding, row virtualisation, grouping,
 * and selection checkboxes. Every one of those is a real feature of a real data
 * grid and none of them is a question this product's screens ask.
 *
 * A11y notes worth stating because they are easy to get silently wrong.
 * `aria-sort` goes on the `<th>` of the *active* column only — putting `none` on
 * every other header is legal and makes a screen reader announce sortability
 * three times per row. Rows carry a roving `tabIndex`, so a keyboard reader tabs
 * *into* the table once and then arrows through it, instead of tabbing past one
 * stop per row. Selection is `aria-current` rather than `aria-selected`, because
 * this is a table, not a listbox, and a `<tr>` outside a grid has no selected
 * state to report.
 */
import { ChevronDown, ChevronUp } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from './utils.ts';

export interface Column<T> {
  readonly id: string;
  readonly header: string;
  readonly cell: (row: T) => ReactNode;
  readonly align?: 'start' | 'end';
  readonly mono?: boolean;
  /**
   * Offer this column as a sort. It takes effect only together with
   * {@link Column.sortValue} — a sortable header with nothing to compare is a
   * control that does nothing when pressed, so the pairing is enforced here
   * rather than trusted at 23 call sites.
   */
  readonly sortable?: boolean;
  readonly sortValue?: (row: T) => string | number;
  readonly width?: string;
}

export interface Sort {
  readonly id: string;
  readonly direction: 'asc' | 'desc';
}

/**
 * The three-state cycle a header press walks: unsorted → ascending →
 * descending → unsorted.
 *
 * Returning to unsorted matters more than it sounds. The order the server sent
 * is itself an answer — newest first, for every one of these ledgers — and a
 * two-state toggle makes that original order unreachable once anything has been
 * pressed.
 */
export function nextSort(current: Sort | null, id: string): Sort | null {
  if (current?.id !== id) return { id, direction: 'asc' };
  if (current.direction === 'asc') return { id, direction: 'desc' };
  return null;
}

export function sortRows<T>(
  rows: readonly T[],
  columns: readonly Column<T>[],
  sort: Sort | null,
): readonly T[] {
  if (sort === null) return rows;
  const column = columns.find((candidate) => candidate.id === sort.id);
  const value = column?.sortValue;
  if (!value) return rows;
  const sign = sort.direction === 'asc' ? 1 : -1;
  // Copied before sorting: `rows` is a read model the caller may be rendering
  // elsewhere, and sorting in place would reorder it under them.
  return [...rows].sort((left, right) => {
    const a = value(left);
    const b = value(right);
    if (typeof a === 'number' && typeof b === 'number') return (a - b) * sign;
    return String(a).localeCompare(String(b)) * sign;
  });
}

interface RowKeyEvent {
  readonly key: string;
  preventDefault: () => void;
}

/**
 * Arrow-key navigation over a list of rows, as a handler.
 *
 * Exported because `ObjectExplorer` needs exactly this behaviour on its own
 * rows and a second implementation would be a second answer to "what does Home
 * do at the top of the list". `onActivate` is what Enter means — open, select,
 * inspect — and is the caller's word, not this module's.
 */
export function rowKeyboard({
  count,
  active,
  onActive,
  onActivate,
}: {
  readonly count: number;
  readonly active: number;
  readonly onActive: (next: number) => void;
  readonly onActivate?: (index: number) => void;
}): (event: RowKeyEvent) => void {
  return (event) => {
    if (count === 0) return;
    // Clamped rather than wrapped. A ledger has a top and a bottom, and
    // arrowing off the end into the other end loses the reader's place in a way
    // that is invisible until they read the wrong row.
    const move = (next: number) => {
      event.preventDefault();
      onActive(Math.min(count - 1, Math.max(0, next)));
    };
    switch (event.key) {
      case 'ArrowDown':
        return move(active + 1);
      case 'ArrowUp':
        return move(active - 1);
      case 'Home':
        return move(0);
      case 'End':
        return move(count - 1);
      case 'Enter':
        if (!onActivate) return;
        event.preventDefault();
        return onActivate(active);
      default:
        return;
    }
  };
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  selectedKey,
  onRowSelect,
  empty,
  caption,
  initialSort,
}: {
  readonly columns: readonly Column<T>[];
  readonly rows: readonly T[];
  readonly rowKey: (row: T) => string;
  readonly selectedKey?: string;
  readonly onRowSelect?: (row: T) => void;
  readonly empty?: ReactNode;
  /**
   * What this table is a table of, for anyone who cannot see that it is one.
   * Rendered to screen readers only — the screen above it already carries the
   * heading a sighted reader needs.
   */
  readonly caption?: string;
  /**
   * The order the rows arrive in, when it is not the order the server sent.
   * A ledger that wants newest-first regardless of the query says so here
   * instead of pre-sorting and losing the header state that explains why.
   */
  readonly initialSort?: Sort;
}) {
  const [sort, setSort] = useState<Sort | null>(initialSort ?? null);
  const [active, setActive] = useState(0);
  const body = useRef<HTMLTableSectionElement>(null);
  // Set only by the key handler, so the effect below never steals focus on
  // mount or when the rows are replaced by a poll.
  const moved = useRef(false);

  const ordered = useMemo(
    () => sortRows(rows, columns, sort),
    [rows, columns, sort],
  );

  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    const node = body.current?.children[active];
    if (node instanceof HTMLElement) node.focus();
  }, [active]);

  if (rows.length === 0 && empty) return <>{empty}</>;

  const selectable = onRowSelect !== undefined;
  const onKeyDown = rowKeyboard({
    count: ordered.length,
    active,
    onActive: (next) => {
      moved.current = true;
      setActive(next);
    },
    onActivate: onRowSelect
      ? (index) => {
          const row = ordered[index];
          if (row !== undefined) onRowSelect(row);
        }
      : undefined,
  });

  return (
    <div className="overflow-x-auto rounded-sm border border-border bg-card">
      <table className="w-full border-collapse text-body">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead className="sticky top-0 z-10 bg-card">
          <tr className="border-b border-border">
            {columns.map((column) => {
              const sortable = column.sortable === true && !!column.sortValue;
              const activeSort = sort?.id === column.id ? sort : null;
              return (
                <th
                  key={column.id}
                  scope="col"
                  style={column.width ? { width: column.width } : undefined}
                  aria-sort={
                    activeSort
                      ? activeSort.direction === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : undefined
                  }
                  className={cn(
                    'px-3 py-2 font-semibold text-caption uppercase tracking-eyebrow text-muted-foreground',
                    column.align === 'end' ? 'text-end' : 'text-start',
                  )}
                >
                  {sortable ? (
                    <button
                      type="button"
                      onClick={() => setSort(nextSort(sort, column.id))}
                      className={cn(
                        'inline-flex items-center gap-1 hover:text-foreground',
                        activeSort && 'text-foreground',
                      )}
                    >
                      {column.header}
                      {activeSort?.direction === 'asc' ? (
                        <ChevronUp className="size-3" />
                      ) : activeSort?.direction === 'desc' ? (
                        <ChevronDown className="size-3" />
                      ) : null}
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody ref={body}>
          {ordered.map((row, index) => {
            const key = rowKey(row);
            const selected = selectedKey !== undefined && selectedKey === key;
            return (
              <tr
                key={key}
                aria-current={selected ? 'true' : undefined}
                tabIndex={selectable ? (index === active ? 0 : -1) : undefined}
                onFocus={selectable ? () => setActive(index) : undefined}
                onClick={
                  onRowSelect
                    ? () => {
                        setActive(index);
                        onRowSelect(row);
                      }
                    : undefined
                }
                onKeyDown={selectable ? onKeyDown : undefined}
                className={cn(
                  'border-b border-border-soft last:border-0',
                  selectable &&
                    'cursor-pointer focus-visible:-outline-offset-2 hover:bg-secondary/60',
                  selected && 'bg-secondary',
                )}
              >
                {columns.map((column) => (
                  <td
                    key={column.id}
                    className={cn(
                      'px-3 py-2.5 align-top',
                      column.align === 'end' ? 'text-end' : 'text-start',
                      column.mono && 'font-mono',
                    )}
                  >
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
