// `/apps/new` rewrites its path to `/apps/new/<id>` once the draft exists. A
// screen keyed on that id would remount and re-read everything, so this mounts
// the route table, which writes the key.
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Screen } from '../../src/web/app.tsx';
import {
  INITIAL_DRAFT,
  REPOSITORY_GRANT,
  REPOSITORY_OPTIONS,
  TARGET_OPTIONS,
} from '../fixtures/scenarios.ts';
import { type DomShim, installDomShim } from '../harness/dom.ts';

const DRAFT_ID = '3a2b1c00-0000-4000-8000-00000000beef';

const DRAFT_VIEW = {
  id: DRAFT_ID,
  revision: 4,
  draft: INITIAL_DRAFT,
  blockers: [],
  ready: true,
};

let called: string[] = [];
let refuseOnce = new Set<string>();

let dom: DomShim;

beforeAll(() => {
  dom = installDomShim({
    fetch: async (url: string) => {
      const name = url.split('/').pop() ?? '';
      called.push(name);
      if (refuseOnce.delete(name)) {
        return {
          json: async () => ({
            ok: false,
            failure: { code: 'INTERNAL', message: 'the database was asleep' },
          }),
        };
      }
      switch (name) {
        case 'startCreationDraft':
        case 'getCreationDraft':
          return { json: async () => ({ ok: true, value: DRAFT_VIEW }) };
        case 'listTargets':
          return {
            json: async () => ({
              ok: true,
              value: { options: TARGET_OPTIONS },
            }),
          };
        case 'listRepositories':
          return {
            json: async () => ({
              ok: true,
              value: {
                repos: [],
                options: REPOSITORY_OPTIONS,
                available: REPOSITORY_GRANT,
                connector: { state: 'unavailable' },
              },
            }),
          };
        default:
          return {
            json: async () => ({
              ok: true,
              value: {
                fullName: 'example/almanac',
                defaultBranch: 'main',
                commit: 'a'.repeat(40),
                scopes: [],
                canConnect: true,
              },
            }),
          };
      }
    },
  });
});

afterAll(() => dom.restore());

beforeEach(() => {
  called = [];
  refuseOnce = new Set();
});

// The hash router's navigation is modelled as a re-render.
function mount(initial: string) {
  const container = dom.document.createElement('div');
  let root!: Root;
  let path = initial;
  const navigate = (next: string) => {
    path = next;
    root.render(<Screen path={path} onNavigate={navigate} />);
  };
  return {
    text: () => container.textContent,
    path: () => path,
    open: () =>
      act(async () => {
        root = createRoot(container as unknown as Element);
        root.render(<Screen path={path} onNavigate={navigate} />);
      }),
    settle: () => act(async () => {}),
    unmount: () => act(() => root.unmount()),
  };
}

const count = (name: string) => called.filter((call) => call === name).length;

describe('a draft becoming addressable', () => {
  test('the rewritten path reads nothing a second time', async () => {
    const screen = mount('/apps/new');
    await screen.open();
    await screen.settle();

    expect(screen.path()).toBe(`/apps/new/${DRAFT_ID}`);
    // A remount would repeat each of these reads.
    expect(count('startCreationDraft')).toBe(1);
    expect(count('getCreationDraft')).toBe(0);
    expect(count('listTargets')).toBe(1);
    expect(count('listRepositories')).toBe(1);
    expect(count('inspectRepository')).toBe(1);

    expect(screen.text()).toContain(INITIAL_DRAFT.detection.reason);
    expect(screen.text()).not.toContain('Recovering the draft');

    screen.unmount();
  });

  test('an addressed draft is read once, without starting one', async () => {
    const screen = mount(`/apps/new/${DRAFT_ID}`);
    await screen.open();
    await screen.settle();

    expect(count('getCreationDraft')).toBe(1);
    expect(count('startCreationDraft')).toBe(0);
    expect(screen.text()).toContain(INITIAL_DRAFT.detection.reason);

    screen.unmount();
  });
});

describe('a load that failed', () => {
  test('says what failed instead of a screen with nothing on it', async () => {
    refuseOnce.add('startCreationDraft');
    const screen = mount('/apps/new');
    await screen.open();
    await screen.settle();

    expect(screen.text()).toContain('the database was asleep');
    expect(screen.text()).toContain('Try again');
    expect(screen.path()).toBe('/apps/new');

    screen.unmount();
  });
});
