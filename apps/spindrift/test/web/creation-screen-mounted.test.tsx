/**
 * The creation screen names its own object partway through, and survives it.
 *
 * `/apps/new` has no id until the draft exists, so the screen starts one and
 * then rewrites the path to `/apps/new/<id>`. Every other screen in the route
 * table is keyed on the id in its path — for the reason `Screen`'s own header
 * gives — and this is the one place that rule turns on itself: the id appearing
 * is not navigation to another draft, it is this draft becoming addressable.
 * Keyed on it, the screen that just started the draft is unmounted and rebuilt,
 * re-reading the draft, the Targets, the repositories and the repository
 * detection, and discarding whatever had been typed in between.
 *
 * So this mounts the route table rather than the screen: the claim is about the
 * key the table writes, and a test rendering `NewAppScreen` itself would supply
 * that key and assert its own prop.
 */
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

/** Every command the mounted table called, in order. */
let called: string[] = [];
/** Command names to refuse once, so a retry can be observed answering. */
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

/** The route table, with the hash router's navigation modelled as a re-render. */
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

    // The rewrite happened: the draft has an id and the path names it.
    expect(screen.path()).toBe(`/apps/new/${DRAFT_ID}`);
    // And every read behind the screen was made exactly once. A remount here
    // costs a second `getCreationDraft`, a second placement resolution, a
    // second repository list and a second read of the repository.
    expect(count('startCreationDraft')).toBe(1);
    expect(count('getCreationDraft')).toBe(0);
    expect(count('listTargets')).toBe(1);
    expect(count('listRepositories')).toBe(1);
    expect(count('inspectRepository')).toBe(1);

    // Still the screen, rather than the placeholder a reload puts back.
    expect(screen.text()).toContain(INITIAL_DRAFT.appName);
    expect(screen.text()).not.toContain('Recovering the draft');

    screen.unmount();
  });

  test('an addressed draft is read once, without starting one', async () => {
    // The other direction: opening the URL directly resumes rather than
    // creating, which is what makes the draft a durable row worth addressing.
    const screen = mount(`/apps/new/${DRAFT_ID}`);
    await screen.open();
    await screen.settle();

    expect(count('getCreationDraft')).toBe(1);
    expect(count('startCreationDraft')).toBe(0);
    expect(screen.text()).toContain(INITIAL_DRAFT.appName);

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
    // And the path was never rewritten, because there is no draft to name.
    expect(screen.path()).toBe('/apps/new');

    screen.unmount();
  });
});
