// The `ui/` primitives. Markup is asserted through `renderToStaticMarkup`, and
// each decision through the pure function the component exports, because the
// DOM shim in `test/harness/dom.ts` cannot click.
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { copyValue, Ref } from '../../src/web/ui/copy.tsx';
import {
  type Column,
  DataTable,
  nextSort,
  rowKeyboard,
  sortRows,
} from '../../src/web/ui/data-table.tsx';
import { Tabs } from '../../src/web/ui/tabs.tsx';
import { Timestamp } from '../../src/web/ui/timestamp.tsx';
import {
  activeToasts,
  dismissToast,
  notify,
  onToastChange,
  ToastHost,
} from '../../src/web/ui/toast.tsx';

interface Build {
  readonly id: string;
  readonly number: number;
  readonly commit: string;
}

const BUILDS: readonly Build[] = [
  { id: 'b1', number: 9, commit: 'ccc1111' },
  { id: 'b2', number: 12, commit: 'aaa2222' },
  { id: 'b3', number: 10, commit: 'bbb3333' },
];

const COLUMNS: readonly Column<Build>[] = [
  {
    id: 'number',
    header: 'Build',
    cell: (row) => `#${row.number}`,
    sortable: true,
    sortValue: (row) => row.number,
  },
  {
    id: 'commit',
    header: 'Commit',
    cell: (row) => row.commit,
    mono: true,
    sortable: true,
    sortValue: (row) => row.commit,
  },
  { id: 'runner', header: 'Runner', cell: () => 'in-cluster' },
];

const order = (markup: string) =>
  BUILDS.map((build) => ({ id: build.id, at: markup.indexOf(build.commit) }))
    .sort((left, right) => left.at - right.at)
    .map((entry) => entry.id);

describe('DataTable sorts what it is told to and says so', () => {
  test('a header cycles unsorted → ascending → descending → unsorted', () => {
    // The third press restores the order the server sent.
    const first = nextSort(null, 'number');
    expect(first).toEqual({ id: 'number', direction: 'asc' });
    const second = nextSort(first, 'number');
    expect(second).toEqual({ id: 'number', direction: 'desc' });
    expect(nextSort(second, 'number')).toBeNull();
  });

  test('pressing a different header starts that column ascending', () => {
    expect(nextSort({ id: 'number', direction: 'desc' }, 'commit')).toEqual({
      id: 'commit',
      direction: 'asc',
    });
  });

  test('numbers compare as numbers', () => {
    expect(
      sortRows(BUILDS, COLUMNS, { id: 'number', direction: 'asc' }).map(
        (row) => row.number,
      ),
    ).toEqual([9, 10, 12]);
    expect(
      sortRows(BUILDS, COLUMNS, { id: 'number', direction: 'desc' }).map(
        (row) => row.number,
      ),
    ).toEqual([12, 10, 9]);
  });

  test('the rows it was handed are never reordered in place', () => {
    sortRows(BUILDS, COLUMNS, { id: 'commit', direction: 'desc' });
    expect(BUILDS.map((row) => row.id)).toEqual(['b1', 'b2', 'b3']);
  });

  test('no sort, or a column with nothing to compare, is the server order', () => {
    expect(sortRows(BUILDS, COLUMNS, null)).toBe(BUILDS);
    expect(sortRows(BUILDS, COLUMNS, { id: 'runner', direction: 'asc' })).toBe(
      BUILDS,
    );
  });

  test('aria-sort marks the active column and only the active column', () => {
    const markup = renderToStaticMarkup(
      <DataTable
        columns={COLUMNS}
        rows={BUILDS}
        rowKey={(row) => row.id}
        caption="Builds"
        initialSort={{ id: 'commit', direction: 'asc' }}
      />,
    );
    // Unsorted headers omit `aria-sort`: `none` on each makes a screen reader
    // announce sortability over and over.
    expect(markup.match(/<th[ >]/g)).toHaveLength(3);
    expect(markup.match(/aria-sort=/g)).toHaveLength(1);
    expect(markup).toContain('<caption class="sr-only">Builds</caption>');
  });

  test('the rendered row order follows the declared sort', () => {
    const ascending = renderToStaticMarkup(
      <DataTable
        columns={COLUMNS}
        rows={BUILDS}
        rowKey={(row) => row.id}
        initialSort={{ id: 'commit', direction: 'asc' }}
      />,
    );
    expect(ascending).toContain('aria-sort="ascending"');
    expect(order(ascending)).toEqual(['b2', 'b3', 'b1']);

    const descending = renderToStaticMarkup(
      <DataTable
        columns={COLUMNS}
        rows={BUILDS}
        rowKey={(row) => row.id}
        initialSort={{ id: 'commit', direction: 'desc' }}
      />,
    );
    expect(descending).toContain('aria-sort="descending"');
    expect(order(descending)).toEqual(['b1', 'b3', 'b2']);
  });

  test('a selectable table is one tab stop, not one per row', () => {
    const markup = renderToStaticMarkup(
      <DataTable
        columns={COLUMNS}
        rows={BUILDS}
        rowKey={(row) => row.id}
        selectedKey="b3"
        onRowSelect={() => undefined}
      />,
    );
    expect(markup.match(/tabindex="0"/g)).toHaveLength(1);
    expect(markup.match(/tabindex="-1"/g)).toHaveLength(2);
    // `aria-selected` is only valid on a row inside a grid, so a table row
    // marks selection with `aria-current`.
    expect(markup).toContain('aria-current="true"');
    expect(markup).not.toContain('aria-selected');
  });

  test('an unselectable table has no tab stops at all', () => {
    const markup = renderToStaticMarkup(
      <DataTable columns={COLUMNS} rows={BUILDS} rowKey={(row) => row.id} />,
    );
    expect(markup).not.toContain('tabindex');
  });

  test('no rows renders what the screen said to render instead', () => {
    const markup = renderToStaticMarkup(
      <DataTable
        columns={COLUMNS}
        rows={[]}
        rowKey={(row) => row.id}
        empty={<p>No Builds yet.</p>}
      />,
    );
    expect(markup).toContain('No Builds yet.');
    expect(markup).not.toContain('<table');
  });
});

describe('the shared row keyboard', () => {
  const press = (key: string, active: number) => {
    const moved: number[] = [];
    const activated: number[] = [];
    let prevented = 0;
    rowKeyboard({
      count: 3,
      active,
      onActive: (next) => moved.push(next),
      onActivate: (index) => activated.push(index),
    })({ key, preventDefault: () => (prevented += 1) });
    return { moved, activated, prevented };
  };

  test('arrows move one row and clamp at both ends', () => {
    expect(press('ArrowDown', 0).moved).toEqual([1]);
    expect(press('ArrowUp', 1).moved).toEqual([0]);
    expect(press('ArrowUp', 0).moved).toEqual([0]);
    expect(press('ArrowDown', 2).moved).toEqual([2]);
  });

  test('Home and End go to the ends', () => {
    expect(press('Home', 2).moved).toEqual([0]);
    expect(press('End', 0).moved).toEqual([2]);
  });

  test('Enter activates the row the reader is on', () => {
    const { activated, moved } = press('Enter', 1);
    expect(activated).toEqual([1]);
    expect(moved).toEqual([]);
  });

  test('any other key is left to the browser', () => {
    const { moved, activated, prevented } = press('Tab', 1);
    expect(moved).toEqual([]);
    expect(activated).toEqual([]);
    // Swallowing Tab would trap a keyboard reader in the table.
    expect(prevented).toBe(0);
  });
});

describe('Timestamp carries the instant, not only the phrase', () => {
  const AT = '2026-08-07T18:04:05.000Z';

  test('the machine-readable instant and the hover agree with each other', () => {
    const markup = renderToStaticMarkup(<Timestamp at={AT} when="8m ago" />);
    // Case-insensitive: React may emit `dateTime` in either casing, and HTML
    // attribute names ignore case.
    expect(markup).toMatch(new RegExp(`datetime="${AT}"`, 'i'));
    expect(markup).toContain(`title="${AT}"`);
    expect(markup).toContain('<time');
  });

  test("a static render shows the server's phrase, so SSR output is unchanged", () => {
    // The server snapshot keeps a browser-computed relative time out of SSR
    // markup.
    expect(renderToStaticMarkup(<Timestamp at={AT} when="8m ago" />)).toContain(
      '8m ago',
    );
  });

  test('an instant the read model could not supply states nothing', () => {
    expect(renderToStaticMarkup(<Timestamp at="" />)).toBe('');
    expect(renderToStaticMarkup(<Timestamp at="" when="8m ago" />)).toContain(
      '8m ago',
    );
  });
});

describe('copying a value', () => {
  const withClipboard = async <T,>(
    clipboard: unknown,
    body: () => Promise<T>,
  ): Promise<T> => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard },
      configurable: true,
      writable: true,
    });
    try {
      return await body();
    } finally {
      if (previous) Object.defineProperty(globalThis, 'navigator', previous);
      else Reflect.deleteProperty(globalThis, 'navigator');
    }
  };

  test('hands the whole value to the clipboard', async () => {
    const written: string[] = [];
    const done = await withClipboard(
      { writeText: async (value: string) => void written.push(value) },
      () => copyValue('sha256:0123456789abcdef0123456789abcdef'),
    );
    expect(done).toBe(true);
    expect(written).toEqual(['sha256:0123456789abcdef0123456789abcdef']);
  });

  test('a refused or absent clipboard is an answer, not a crash', async () => {
    expect(await withClipboard(undefined, () => copyValue('x'))).toBe(false);
    expect(
      await withClipboard(
        {
          writeText: async () => {
            throw new Error('denied');
          },
        },
        () => copyValue('x'),
      ),
    ).toBe(false);
  });

  test('Ref shortens what it shows and copies what it was given', () => {
    const digest = 'sha256:0123456789abcdef0123456789abcdef';
    const markup = renderToStaticMarkup(<Ref value={digest} kind="digest" />);
    expect(markup).toContain('>sha256:0123456789ab<');
    expect(markup).toContain(`title="${digest}"`);
    expect(markup).toContain('aria-label="Copy digest"');
  });
});

describe('Tabs are one tab stop with a selected tab', () => {
  const ITEMS = [
    { id: 'sources', label: 'Sources' },
    { id: 'builds', label: 'Builds', count: 12 },
    { id: 'artifacts', label: 'Artifacts' },
  ];

  const markup = renderToStaticMarkup(
    <Tabs
      items={ITEMS}
      current="builds"
      onSelect={() => undefined}
      label="Supply chain"
    />,
  );

  test('the roving tabindex leaves exactly one stop', () => {
    expect(markup.match(/tabindex="0"/g)).toHaveLength(1);
    expect(markup.match(/tabindex="-1"/g)).toHaveLength(2);
  });

  test('the selection is a selection, not a claim about the page', () => {
    expect(markup).toContain('role="tablist"');
    expect(markup.match(/role="tab"/g)).toHaveLength(3);
    expect(markup).toContain('aria-selected="true"');
    expect(markup).not.toContain('aria-current');
  });

  test('a count belongs to the tab that has one', () => {
    expect(markup).toContain('12');
  });
});

describe('the toast store', () => {
  test('notify reaches a subscriber, and unsubscribing stops it', () => {
    let seen = 0;
    const stop = onToastChange(() => (seen += 1));
    notify({ tone: 'success', title: 'Rolled back to build 1187' });
    expect(seen).toBe(1);
    expect(activeToasts().map((toast) => toast.title)).toContain(
      'Rolled back to build 1187',
    );

    const id = activeToasts()[activeToasts().length - 1]?.id ?? '';
    dismissToast(id);
    expect(seen).toBe(2);
    expect(activeToasts().map((toast) => toast.id)).not.toContain(id);

    stop();
    notify({ tone: 'accent', title: 'ignored' });
    expect(seen).toBe(2);
    dismissToast(activeToasts()[activeToasts().length - 1]?.id ?? '');
  });

  test('dismissing something already gone notifies nobody', () => {
    let seen = 0;
    const stop = onToastChange(() => (seen += 1));
    dismissToast('toast:nonexistent');
    stop();
    expect(seen).toBe(0);
  });

  test('a static render of the host is the live region and nothing in it', () => {
    notify({ tone: 'destructive', title: 'The rollback was refused' });
    const markup = renderToStaticMarkup(<ToastHost />);
    // Screen readers miss a live region inserted with its content, so it
    // renders empty. The server snapshot is empty, so no toast reaches SSR.
    expect(markup).toContain('aria-live="polite"');
    expect(markup).not.toContain('The rollback was refused');
    dismissToast(activeToasts()[activeToasts().length - 1]?.id ?? '');
  });
});
