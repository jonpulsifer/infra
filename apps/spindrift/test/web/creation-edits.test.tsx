// Draft edits and the server's draft must not drift apart. The DOM shim has no
// event system, so each case is tested as a decision or through a mounted effect.
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
import { blockersFor, draftReducer } from '../../src/domain/creation-draft.ts';
import type { TransportFailure } from '../../src/web/client.ts';
import {
  deployDraft,
  LOST_TITLE,
  UNSAVED_TITLE,
} from '../../src/web/views/apps/new/deploy.ts';
import type { InspectedScope } from '../../src/web/views/apps/new/detect.ts';
import {
  type DetectionTrouble,
  NewApp,
  standingTrouble,
} from '../../src/web/views/apps/new/index.tsx';
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
    const outcome = await deployDraft(steps(REFUSED));

    expect(outcome).toEqual({
      act: 'unsaved',
      failure: REFUSED,
      title: UNSAVED_TITLE,
    });
    expect(held.completed).toBe(0);
  });

  test('flushes the pending write before deciding', async () => {
    // The last edit may still be waiting in the debounce timer.
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

  test('a stale revision is the press to recover from, not one to report', async () => {
    // With the last edit already saved the flush sends nothing, so completing is
    // the first request to carry the superseded revision.
    const outcome = await deployDraft({
      flush: async () => {},
      unsaved: () => null,
      complete: async () => ({
        ok: false as const,
        failure: {
          code: 'STALE_EDIT',
          message: 'this creation draft changed in another browser',
        },
      }),
    });

    expect(outcome).toEqual({ act: 'stale' });
  });

  test('a completion that never answered says the App may exist', async () => {
    // `command` throws when the server did not answer, so the App may exist.
    const outcome = await deployDraft({
      flush: async () => {},
      unsaved: () => null,
      complete: async () => {
        throw new Error(
          'dispatch of completeCreationDraft answered 502 with no command result',
        );
      },
    });

    expect(outcome.act).toBe('lost');
    expect(outcome.act === 'lost' && outcome.title).toBe(LOST_TITLE);
    expect(outcome.act === 'lost' && outcome.failure.message).toContain('502');
    expect(outcome.act === 'lost' && outcome.failure.message).toContain(
      'Check Apps',
    );
  });
});

// What `inspectRepository` answers with.
let scopes: readonly InspectedScope[] = [];
let refuse = new Map<string, TransportFailure>();
let called: string[] = [];
let saved: Draft[] = [];
// What `getCreationDraft` answers a resync with.
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
    // Lets the trailing debounce fire and its save land.
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
  buildCommand: null,
  outputDirectory: null,
  watchPaths: [scope],
  configured: false,
  unavailable: {},
});

describe('an edit the server refused as stale', () => {
  test('re-reads the draft and says another tab won', async () => {
    // Without a re-read, every later save would carry the same stale revision.
    scopes = [detected('apps/only')];
    stored = { ...repoDraft, appName: 'renamed-elsewhere' };
    refuse.set('saveCreationDraft', {
      code: 'STALE_EDIT',
      message: 'this creation draft changed in another browser',
    });

    const screen = await mount(repoDraft);
    await screen.settleWrites();

    expect(called.filter((call) => call === 'saveCreationDraft')).toHaveLength(
      1,
    );
    expect(called).toContain('getCreationDraft');
    expect(screen.text()).toContain('renamed-elsewhere');
    expect(screen.text()).toContain('This draft was edited somewhere else');
    expect(screen.text()).toContain('STALE_EDIT');
    // Nothing from this tab reached the server, so the screen shows the other
    // tab's draft, not a merge.
    expect(saved).toEqual([]);

    screen.unmount();
  });
});

describe('a repository nothing could be read from', () => {
  test('blocks Deploy rather than staying deployable on a stale claim', async () => {
    // Until the repository is read, Source holds only the draft's opening guess.
    refuse.set('inspectRepository', {
      code: 'NOT_FOUND',
      message: 'no repository example/almanac is available to this operator',
    });

    const screen = await mount(repoDraft);

    expect(screen.text()).toContain('could not read example/almanac');
    expect(screen.text()).toContain('to fix above');

    screen.unmount();
  });

  test('a repository that was read and holds nothing buildable does not', async () => {
    // This one was read, so the operator can still name a directory and pick a kind.
    scopes = [{ scope: '.', outcome: 'unsupported', detail: 'just prose.' }];

    const screen = await mount(repoDraft);

    expect(screen.text()).toContain('does not know how to build');
    expect(screen.text()).not.toContain('could not read example/almanac');
    expect(screen.text()).not.toContain('Spindrift stops before Build #1');

    screen.unmount();
  });
});

// The Deploy blocker above derives from this sentence.
describe('the sentence a read left', () => {
  const unread: DetectionTrouble = {
    kind: 'unread',
    repo: 'example/almanac',
    message: 'GitHub is rate-limiting Spindrift.',
  };

  test('survives an edit that cannot have made the repository readable', () => {
    // Neither edit reads anything: the directory field re-reads on blur, and the
    // tile is the same source again.
    const typed = draftReducer(repoDraft, {
      type: 'subpath',
      subpath: 'apps/a',
    });
    const looked = draftReducer(repoDraft, { type: 'entry', entry: 'repo' });

    expect(standingTrouble(typed, unread)).toBe(unread);
    expect(standingTrouble(looked, unread)).toBe(unread);
  });

  test('goes when the draft names another repository', () => {
    const switched = draftReducer(repoDraft, {
      type: 'repo',
      fullName: 'example/ledger',
      url: 'https://vcs.example/example/ledger.git',
    });

    expect(standingTrouble(switched, unread)).toBeNull();
  });

  test('and when the source stops being a repository at all', () => {
    const uploading = draftReducer(repoDraft, {
      type: 'entry',
      entry: 'upload',
    });

    expect(standingTrouble(uploading, unread)).toBeNull();
  });

  test('one about a directory goes when the directory does', () => {
    // This one was read and is about `docs`, so changing the directory clears it.
    const about: DetectionTrouble = {
      kind: 'unsupported',
      repo: 'example/almanac',
      scope: 'docs',
      message: 'Spindrift does not know how to build docs in example/almanac',
    };
    const named = draftReducer(repoDraft, { type: 'subpath', subpath: 'docs' });
    const moved = draftReducer(named, { type: 'subpath', subpath: 'apps/web' });

    expect(standingTrouble(named, about)).toBe(about);
    expect(standingTrouble(moved, about)).toBeNull();
  });
});

describe('the Code row', () => {
  test('opens while nothing has answered which directory to deploy', async () => {
    scopes = [detected('apps/one'), detected('apps/two')];

    const screen = await mount(repoDraft);

    expect(screen.text()).toContain('Directories in this repo');

    screen.unmount();
  });

  test('collapses once the directory is somebody’s answer', async () => {
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

    expect(screen.text()).not.toContain('Directories in this repo');

    screen.unmount();
  });
});
