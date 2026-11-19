/**
 * Rows of facts as a sortable table. Sorting runs in the browser, over the page
 * of rows the screen already holds.
 */
import { ChevronDown, ChevronRight, ChevronUp } from 'lucide-react';
import {
  Fragment,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { cn } from './utils.ts';

export interface Column<T> {
  readonly id: string;
  readonly header: string;
  readonly cell: (row: T) => ReactNode;
  readonly align?: 'start' | 'end';
  readonly mono?: boolean;
  /** Takes effect only with {@link Column.sortValue}. */
  readonly sortable?: boolean;
  readonly sortValue?: (row: T) => string | number;
  readonly width?: string;
}

/** Rows that open in place, each behind a disclosure in a leading cell. */
export interface RowExpansion<T> {
  readonly expandedKey: string | null;
  readonly onToggle: (row: T) => void;
  readonly render: (row: T) => ReactNode;
  /** The disclosure's accessible name. */
  readonly label: (row: T) => string;
}

export interface Sort {
  readonly id: string;
  readonly direction: 'asc' | 'desc';
}

/** Ascending, descending, then unsorted, which restores the server's order. */
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
  // Copied, since sorting in place would reorder the caller's rows.
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
    // Clamped at both ends, since wrapping would lose the reader's place.
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
  expansion,
}: {
  readonly columns: readonly Column<T>[];
  readonly rows: readonly T[];
  readonly rowKey: (row: T) => string;
  readonly selectedKey?: string;
  readonly onRowSelect?: (row: T) => void;
  readonly empty?: ReactNode;
  /** For screen readers only; the page heading serves sighted readers. */
  readonly caption?: string;
  /** An order other than the server's, shown as the active header sort. */
  readonly initialSort?: Sort;
  /** Replaces `onRowSelect`: a row toggles its detail instead of selecting. */
  readonly expansion?: RowExpansion<T>;
}) {
  const [sort, setSort] = useState<Sort | null>(initialSort ?? null);
  const [active, setActive] = useState(0);
  const body = useRef<HTMLTableSectionElement>(null);
  const toggles = useRef<(HTMLButtonElement | null)[]>([]);
  const detailId = useId();
  const expandable = expansion !== undefined;
  // Set only by the key handler, so focus never moves on mount or on a poll.
  const moved = useRef(false);

  const ordered = useMemo(
    () => sortRows(rows, columns, sort),
    [rows, columns, sort],
  );

  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    // Detail rows sit between table rows, so the disclosures are counted.
    const node = expandable
      ? toggles.current[active]
      : body.current?.children[active];
    if (node instanceof HTMLElement) node.focus();
  }, [active, expandable]);

  if (rows.length === 0 && empty) return <>{empty}</>;

  const selectable = onRowSelect !== undefined && !expandable;
  const onKeyDown = rowKeyboard({
    count: ordered.length,
    active,
    onActive: (next) => {
      moved.current = true;
      setActive(next);
    },
    // A disclosure is a button, which answers Enter and Space itself.
    onActivate:
      onRowSelect && !expandable
        ? (index) => {
            const row = ordered[index];
            if (row !== undefined) onRowSelect(row);
          }
        : undefined,
  });

  const cells = (row: T) =>
    columns.map((column) => (
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
    ));

  return (
    <div className="overflow-x-auto rounded-sm border border-border bg-card">
      <table className="w-full border-collapse text-body">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead className="sticky top-0 z-10 bg-card">
          <tr className="border-b border-border">
            {expansion ? (
              <th scope="col" className="w-9 px-2 py-2">
                <span className="sr-only">Details</span>
              </th>
            ) : null}
            {columns.map((column) => {
              const sortable = column.sortable === true && !!column.sortValue;
              const activeSort = sort?.id === column.id ? sort : null;
              return (
                <th
                  key={column.id}
                  scope="col"
                  style={column.width ? { width: column.width } : undefined}
                  // Unset on inactive columns: `none` makes screen readers
                  // announce every header as sortable.
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
            if (expansion) {
              const expanded = expansion.expandedKey === key;
              const detail = `${detailId}-${index}`;
              const toggle = () => {
                setActive(index);
                expansion.onToggle(row);
              };
              return (
                <Fragment key={key}>
                  <tr
                    onClick={(event) => {
                      // A control in the row, the disclosure among them, answers
                      // its own click.
                      const target = event.target as Element;
                      if (target.closest('a, button, input')) return;
                      toggle();
                    }}
                    className={cn(
                      'cursor-pointer border-b border-border-soft last:border-0 hover:bg-secondary/60',
                      expanded && 'bg-secondary',
                    )}
                  >
                    <td className="px-2 py-2 align-top">
                      <button
                        type="button"
                        ref={(node) => {
                          toggles.current[index] = node;
                        }}
                        aria-expanded={expanded}
                        aria-controls={expanded ? detail : undefined}
                        aria-label={expansion.label(row)}
                        tabIndex={index === active ? 0 : -1}
                        onFocus={() => setActive(index)}
                        onKeyDown={onKeyDown}
                        onClick={toggle}
                        className="inline-flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                      >
                        <ChevronRight
                          aria-hidden="true"
                          className={cn(
                            'size-3.5 transition-transform motion-reduce:transition-none',
                            expanded && 'rotate-90',
                          )}
                        />
                      </button>
                    </td>
                    {cells(row)}
                  </tr>
                  {expanded ? (
                    <tr id={detail} className="border-b border-border-soft">
                      <td
                        colSpan={columns.length + 1}
                        className="bg-inspector p-5 sm:p-6"
                      >
                        {/* Zero width, so the detail never widens the table. */}
                        <div className="w-0 min-w-full">
                          {expansion.render(row)}
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            }
            const selected = selectedKey !== undefined && selectedKey === key;
            return (
              <tr
                key={key}
                // A `<tr>` outside a grid has no selected state.
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
                {cells(row)}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
