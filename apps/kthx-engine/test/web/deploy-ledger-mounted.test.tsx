// The Deploys ledger opens a row in place. Mounted, since which row is open is
// state kept across renders.
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { DeployLedgerItem } from '../../src/commands/views.ts';
import { DeployLedger } from '../../src/web/views/operations/deploys.tsx';
import { DEPLOY_SCENARIOS } from '../fixtures/scenarios.ts';
import {
  type DomShim,
  ELEMENT_NODE,
  type FakeNode,
  installDomShim,
} from '../harness/dom.ts';

const DEPLOY: DeployLedgerItem = {
  id: 993,
  appId: 'app-morrow',
  app: 'morrow',
  buildId: 1837,
  componentId: 'component-web',
  component: 'web',
  targetId: 'target-folly',
  target: 'Folly',
  phase: 'LIVE',
  commit: '5bc1000000000000000000000000000000000000',
  configVersion: '9e2bc1',
  when: '2m ago',
  at: '2026-08-03T12:44:00.000Z',
  current: true,
  rollbackable: false,
};
const OLDER: DeployLedgerItem = {
  ...DEPLOY,
  id: 992,
  buildId: 1836,
  current: false,
};

let reads: unknown[] = [];
let dom: DomShim;

beforeAll(() => {
  dom = installDomShim({
    fetch: async (_url: string, init?: { body?: string }) => {
      reads.push(JSON.parse(init?.body ?? '{}'));
      return {
        json: async () => ({
          ok: true,
          value: { deploy: DEPLOY_SCENARIOS.live },
        }),
      };
    },
  });
});

afterAll(() => dom.restore());

beforeEach(() => {
  reads = [];
});

function find(
  root: FakeNode,
  match: (node: FakeNode) => boolean,
): FakeNode | null {
  if (root.nodeType === ELEMENT_NODE && match(root)) return root;
  for (const child of root.childNodes) {
    const found = find(child, match);
    if (found) return found;
  }
  return null;
}

/** The shim dispatches no events, so this reads the props React attached. */
function handlers(node: FakeNode): {
  onClick?: (event: unknown) => void;
} {
  const key = Object.keys(node).find((k) => k.startsWith('__reactProps$'));
  if (!key) throw new Error('React attached no props to this node');
  return (node as unknown as Record<string, { onClick?: () => void }>)[key]!;
}

async function click(node: FakeNode, event: unknown = {}): Promise<void> {
  const { onClick } = handlers(node);
  if (!onClick) throw new Error('the node has no click handler');
  await act(async () => {
    onClick(event);
  });
}

function mount(deploys: readonly DeployLedgerItem[]) {
  const visited: string[] = [];
  const container = dom.document.createElement('div');
  const root = createRoot(container as unknown as Element);
  act(() => {
    root.render(
      <DeployLedger
        deploys={deploys}
        hasMore
        onLoadMore={() => undefined}
        onNavigate={(path) => visited.push(path)}
      />,
    );
  });
  const disclosure = (id: number) => {
    const node = find(
      container,
      (n) =>
        n.tagName === 'BUTTON' &&
        n.getAttribute('aria-label') === `Deploy ${id}`,
    );
    if (!node) throw new Error(`Deploy ${id} has no disclosure`);
    return node;
  };
  return {
    container,
    visited,
    disclosure,
    text: () => container.textContent,
    unmount: () => act(() => root.unmount()),
  };
}

describe('the Deploys ledger opens a row in place', () => {
  test('starts with every row shut and no side inspector', () => {
    const screen = mount([DEPLOY, OLDER]);

    expect(screen.disclosure(993).getAttribute('aria-expanded')).toBe('false');
    expect(screen.disclosure(992).getAttribute('aria-expanded')).toBe('false');
    expect(screen.text()).not.toContain('Observed evidence');
    expect(find(screen.container, (n) => n.tagName === 'ARTICLE')).toBeNull();
    expect(reads).toEqual([]);
    expect(screen.text()).toContain('Load older Deploys');

    screen.unmount();
  });

  test('a press opens the row below itself, and a second press shuts it', async () => {
    const screen = mount([DEPLOY, OLDER]);
    const toggle = screen.disclosure(993);

    await click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const controls = toggle.getAttribute('aria-controls');
    const detail = find(
      screen.container,
      (n) => n.getAttribute('id') === controls,
    );
    expect(detail?.tagName).toBe('TR');
    expect(detail?.textContent).toContain('Placing Build 1837 on Folly');
    expect(detail?.textContent).toContain('Observed evidence');
    expect(reads).toEqual([{ id: 993 }]);

    await click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBeNull();
    expect(screen.text()).not.toContain('Observed evidence');

    screen.unmount();
  });

  test('opening one row shuts the other', async () => {
    const screen = mount([DEPLOY, OLDER]);

    await click(screen.disclosure(993));
    await click(screen.disclosure(992));

    expect(screen.disclosure(993).getAttribute('aria-expanded')).toBe('false');
    expect(screen.disclosure(992).getAttribute('aria-expanded')).toBe('true');
    expect(screen.text()).toContain('Placing Build 1836 on Folly');
    expect(screen.text()).not.toContain('Placing Build 1837 on Folly');

    screen.unmount();
  });

  test('a click anywhere on the row opens it, but a control in it keeps its click', async () => {
    const screen = mount([DEPLOY]);
    const row = screen.disclosure(993).parentNode?.parentNode;
    if (!row) throw new Error('the disclosure sits in no row');
    expect(row.tagName).toBe('TR');

    await click(row, { target: { closest: () => ({ tagName: 'BUTTON' }) } });
    expect(screen.disclosure(993).getAttribute('aria-expanded')).toBe('false');

    await click(row, { target: { closest: () => null } });
    expect(screen.disclosure(993).getAttribute('aria-expanded')).toBe('true');

    screen.unmount();
  });

  test('the open row still navigates to its Deploy and App', async () => {
    const screen = mount([DEPLOY]);
    await click(screen.disclosure(993));

    for (const label of ['Open Deploy', 'Open App']) {
      const button = find(
        screen.container,
        (n) => n.tagName === 'BUTTON' && n.textContent === label,
      );
      if (!button) throw new Error(`no ${label} button`);
      await click(button);
    }
    expect(screen.visited).toEqual(['/deploys/993', '/apps/app-morrow']);

    screen.unmount();
  });
});
