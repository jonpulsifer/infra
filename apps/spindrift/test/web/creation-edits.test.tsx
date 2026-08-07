/**
 * Editing a draft cannot strand, mislead, or silently drop what was typed.
 *
 * The defects here are one family: state the screen holds and state the server
 * holds drifting apart with no way back. Each one is observed at the seam it
 * lives at — the Deploy sequence as a decision, the recovery through the
 * mounted screen's own effect, the read failure as a prerequisite — because the
 * DOM shim has no event system and typing is not something a test can do here.
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
import type { Draft } from '../../src/domain/creation-draft.ts';
import { blockersFor } from '../../src/domain/creation-draft.ts';
import type { TransportFailure } from '../../src/web/client.ts';
import {
  deployDraft,
  UNSAVED_TITLE,
} from '../../src/web/views/apps/new/deploy.ts';
import type { InspectedScope } from '../../src/web/views/apps/new/detect.ts';
import { NewApp } from '../../src/web/views/apps/new/index.tsx';
import { WRITE_DELAY } from '../../src/web/views/apps/new/writes.ts';
import {
  INITIAL_DRAFT,
  REPOSITORY_GRANT,
  REPOSITORY_OPTIONS,
  TARGET_OPTIONS,
} from '../fixtures/scenarios.ts';
import { type DomShim, installDomShim } from '../harness/dom.ts';

const CANDIDATES = TARGET_OPTIONS.filter((target) => target.candidate).map(
  (target) => target.targetId,
);

const REFUSED: TransportFailure = {
  code: 'INTERNAL',
  message: 'the draft could not be written',
};

describe('Deploy after a save that failed', () => {
  const held = { flushed: 0, completed: 0 };
  const steps = (unsaved: TransportFailure | null) => ({
    flush: async () => {
      held.flushed += 1;
    },
    unsaved: () => unsaved,
    complete: async () => {
      held.completed += 1;
      return { ok: true as const, value: { draft: null, app: null } as never };
    },
  });

  beforeEach(() => {
    held.flushed = 0;
    held.completed = 0;
  });

  test('answers with what failed, and creates nothing', async () => {
    // The press used to clear the refusal, await the chain, and return — so the
    // one sentence explaining why nothing happened was erased by the act that
    // did nothing.
    const outcome = await deployDraft(steps(REFUSED));

    expect(outcome).toEqual({
      act: 'unsaved',
      failure: REFUSED,
      title: UNSAVED_TITLE,
    });
    expect(held.completed).toBe(0);
  });

  test('flushes the pending write before deciding', async () => {
    // The debounce means the last edit may still be in a timer. Completing
    // before it lands creates an App from the answer before the last one.
    await deployDraft(steps(null));

    expect(held.flushed).toBe(1);
    expect(held.completed).toBe(1);
  });

  test('a refusal from the completing command is its own answer', async () => {
    const outcome = await deployDraft({
      flush: async () => {},
      unsaved: () => null,
      complete: async () => ({ ok: false as const, failure: REFUSED }),
    });

    expect(outcome).toEqual({ act: 'refused', failure: REFUSED });
  });
});

/** What `inspectRepository` answers with, per test. */
let scopes: readonly InspectedScope[] = [];
/** Command names to refuse once, and with what. */
let refuse = new Map<string, TransportFailure>();
/** Every command the screen called, in order. */
let called: string[] = [];
/** Every draft the screen wrote back. */
let saved: Draft[] = [];
/** What `getCreationDraft` answers a resync with. */
let stored: Draft = INITIAL_DRAFT;

let dom: DomShim;

beforeAll(() => {
  dom = installDomShim({
    fetch: async (url: string, init: { body: string }) => {
      const name = url.split('/').pop() ?? '';
      called.push(name);
      const refusal = refuse.get(name);
      if (refusal !== undefined) {
        refuse.delete(name);
        return { json: async () => ({ ok: false, failure: refusal }) };
      }
      if (name === 'inspectRepository') {
        return {
          json: async () => ({
            ok: true,
            value: {
              fullName: 'example/almanac',
              defaultBranch: 'main',
              commit: 'a'.repeat(40),
              scopes,
              canConnect: true,
            },
          }),
        };
      }
      if (name === 'saveCreationDraft') {
        saved.push((JSON.parse(init.body) as { draft: Draft }).draft);
        return {
          json: async () => ({
            ok: true,
            value: { id: 'draft', revision: 9, draft: null, blockers: [] },
          }),
        };
      }
      if (name === 'getCreationDraft') {
        return {
          json: async () => ({
            ok: true,
            value: {
              id: 'draft',
              revision: 12,
              draft: stored,
              blockers: [],
              ready: true,
            },
          }),
        };
      }
      return {
        json: async () => ({ ok: true, value: { options: TARGET_OPTIONS } }),
      };
    },
  });
});

afterAll(() => dom.restore());

beforeEach(() => {
  scopes = [];
  refuse = new Map();
  called = [];
  saved = [];
  stored = INITIAL_DRAFT;
});

const clean: Draft = {
  ...INITIAL_DRAFT,
  config: INITIAL_DRAFT.config.map((key) => ({ ...key, supplied: true })),
};

const repoDraft: Draft = {
  ...clean,
  source: {
    kind: 'repo',
    repo: 'example/almanac',
    url: 'https://vcs.example/example/almanac.git',
    subpath: '.',
  },
};

async function mount(draft: Draft) {
  const container = dom.document.createElement('div');
  let root!: Root;
  await act(async () => {
    root = createRoot(container as unknown as Element);
    root.render(
      <NewApp
        initial={{
          id: crypto.randomUUID(),
          revision: 0,
          draft,
          blockers: blockersFor(draft, CANDIDATES),
          ready: false,
        }}
        targets={TARGET_OPTIONS}
        repos={REPOSITORY_OPTIONS}
        available={REPOSITORY_GRANT}
      />,
    );
  });
  await act(async () => {});
  return {
    text: () => container.textContent,
    /** Let the trailing debounce fire and its save land. */
    settleWrites: () =>
      act(async () => {
        await new Promise((done) => setTimeout(done, WRITE_DELAY + 60));
      }),
    unmount: () => act(() => root.unmount()),
  };
}

const detected = (scope: string): InspectedScope => ({
  scope,
  outcome: 'detected',
  kind: 'service',
  reason: 'Go — go.mod is in this directory',
  frontend: 'railpack',
  dockerfile: null,
  outputDirectory: null,
  watchPaths: [scope],
  configured: false,
  unavailable: {},
});

describe('an edit the server refused as stale', () => {
  test('re-reads the draft and says another tab won', async () => {
    // The revision guard makes one refused save refuse every save after it:
    // the tab holds a version that no longer exists, so the next keystroke is
    // refused for the same reason, forever.
    scopes = [detected('apps/only')];
    stored = { ...repoDraft, componentName: 'renamed-elsewhere' };
    refuse.set('saveCreationDraft', {
      code: 'STALE_EDIT',
      message: 'this creation draft changed in another browser',
    });

    const screen = await mount(repoDraft);
    await screen.settleWrites();

    // One write attempt, not one per state change on the way in.
    expect(called.filter((call) => call === 'saveCreationDraft')).toHaveLength(
      1,
    );
    expect(called).toContain('getCreationDraft');
    // The server's draft is on screen, and the screen says why it moved.
    expect(screen.text()).toContain('renamed-elsewhere · service');
    expect(screen.text()).toContain('This draft was edited somewhere else');
    expect(screen.text()).toContain('STALE_EDIT');
    // And no draft of this tab's reached the server, so what is on screen is
    // the other tab's version rather than a merge of the two.
    expect(saved).toEqual([]);

    screen.unmount();
  });
});

describe('a repository nothing could be read from', () => {
  test('blocks Deploy rather than staying deployable on a stale claim', async () => {
    // Everything under Source is the draft's opening claim until something has
    // read the repository — a kind nothing checked, a directory nothing looked
    // in. Deploying that builds a guess.
    refuse.set('inspectRepository', {
      code: 'NOT_FOUND',
      message: 'no repository example/almanac is available to this operator',
    });

    const screen = await mount(repoDraft);

    expect(screen.text()).toContain('could not read example/almanac');
    expect(screen.text()).toContain('Spindrift stops before Build #1');

    screen.unmount();
  });

  test('a repository that was read and holds nothing buildable does not', async () => {
    // The other half of the same split: this one was read, and §5 keeps the
    // assertion path open — name the directory, pick the kind.
    scopes = [{ scope: '.', outcome: 'unsupported', detail: 'just prose.' }];

    const screen = await mount(repoDraft);

    expect(screen.text()).toContain('does not know how to build');
    expect(screen.text()).not.toContain('could not read example/almanac');
    expect(screen.text()).not.toContain('Spindrift stops before Build #1');

    screen.unmount();
  });
});

describe('the Source row', () => {
  test('opens while nothing has answered which directory to deploy', async () => {
    // The repository is chosen and the directory is not, which is the state a
    // fresh draft opens in — the question is the row, so the row is open.
    scopes = [detected('apps/one'), detected('apps/two')];

    const screen = await mount(repoDraft);

    expect(screen.text()).toContain('Directories Spindrift read');

    screen.unmount();
  });

  test('collapses once the directory is somebody’s answer', async () => {
    // Settled, so the alternatives are noise.
    scopes = [detected('apps/one'), detected('apps/two')];

    const screen = await mount({
      ...repoDraft,
      scopeByOperator: true,
      source: {
        kind: 'repo',
        repo: 'example/almanac',
        url: 'https://vcs.example/example/almanac.git',
        subpath: 'apps/one',
      },
    });

    expect(screen.text()).not.toContain('Directories Spindrift read');

    screen.unmount();
  });
});
