/**
 * What the creation screen does with what detection found, mounted.
 *
 * These are claims about the screen's *behaviour* rather than its markup, and
 * behaviour here is one effect and one command call: the wizard opens claiming
 * a kind, and until something asks `inspectRepository` that claim is the
 * default nobody chose. A static render cannot observe an effect, so this file
 * mounts the screen and answers its one read.
 *
 * Four properties, and they are the four ways this went wrong before:
 *
 * 1. **It asks.** A draft carries `detection` from the moment it exists, with
 *    the sentence "until detection says otherwise" — so a screen that never
 *    asks renders a claim about a repository nobody read.
 * 2. **It offers everything it was told.** `inspectRepository` answers about
 *    every directory it looked at, unsupported ones included with the reason,
 *    and §5 makes that a list for a human to choose from.
 * 3. **It does not choose.** One candidate is a proposal; two is a question,
 *    and taking the alphabetically first is a decision nobody can see being
 *    made.
 * 4. **It does not re-choose.** The same read runs on every reopen of a
 *    durable draft, and applying its proposal a second time reverts — durably,
 *    through the save that follows — what somebody already corrected.
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
import { blockersFor, draftReducer } from '../../src/domain/creation-draft.ts';
import type { ComponentKind } from '../../src/domain/desired-state.ts';
import {
  type InspectedScope,
  inspection,
  mergeScopes,
  outcomeOf,
} from '../../src/web/views/apps/new/detect.ts';
import { NewApp } from '../../src/web/views/apps/new/index.tsx';
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

const detected = (
  scope: string,
  kind: ComponentKind,
  reason: string,
): InspectedScope => ({
  scope,
  outcome: 'detected',
  kind,
  reason,
  frontend: 'railpack',
  dockerfile: null,
  outputDirectory: null,
  watchPaths: [scope],
  configured: false,
  unavailable: { job: 'jobs are asserted, never inferred' },
});

const unsupported = (scope: string, detail: string): InspectedScope => ({
  scope,
  outcome: 'unsupported',
  detail,
});

/** What `inspectRepository` answers, per test. */
let scopes: readonly InspectedScope[] = [];
/** Every command the screen called, in order. */
let called: string[] = [];
/** Every draft the screen wrote back, in order. */
let saved: Draft[] = [];

let dom: DomShim;

beforeAll(() => {
  dom = installDomShim({
    fetch: async (url: string, init: { body: string }) => {
      const name = url.split('/').pop() ?? '';
      called.push(name);
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
        // Recorded rather than counted: what the screen decided on its own is
        // only visible in what it wrote back.
        saved.push((JSON.parse(init.body) as { draft: Draft }).draft);
        return {
          json: async () => ({
            ok: true,
            value: { id: 'draft', revision: 1, draft: null, blockers: [] },
          }),
        };
      }
      // `listTargets` re-resolves placement whenever a detection moves the
      // kind. Answering with the same options keeps that off these assertions.
      return {
        json: async () => ({ ok: true, value: { options: TARGET_OPTIONS } }),
      };
    },
  });
});

afterAll(() => dom.restore());

beforeEach(() => {
  scopes = [];
  called = [];
  saved = [];
});

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
  // The read is issued from a first-render effect, so its answer lands on the
  // turn after the mount.
  await act(async () => {});
  return {
    text: () => container.textContent,
    unmount: () => act(() => root.unmount()),
  };
}

const clean: Draft = {
  ...INITIAL_DRAFT,
  config: INITIAL_DRAFT.config.map((key) => ({ ...key, supplied: true })),
};

describe('the screen reads the repository it opens on', () => {
  test('detection runs without anybody pressing anything', async () => {
    scopes = [
      detected('apps/web', 'website', 'Astro — `astro` is a dependency'),
    ];

    const screen = await mount(clean);

    expect(called).toContain('inspectRepository');
    // And the answer replaces the default the draft was carrying.
    expect(screen.text()).toContain('astro');
    expect(screen.text()).not.toContain('until detection says otherwise');

    screen.unmount();
  });

  test('an upload draft reads nothing, because there is nothing to read', async () => {
    const screen = await mount({
      ...clean,
      entry: 'upload',
      source: {
        kind: 'archive',
        filename: 'dist.zip',
        digest: `sha256:${'0'.repeat(64)}`,
        location: 'https://bundles.example.test/dist.zip',
        contents: 'source',
        subpath: '.',
      },
    });

    expect(called).not.toContain('inspectRepository');

    screen.unmount();
  });
});

describe('every directory it read is on the screen', () => {
  test('a repository with several candidates offers them all, and picks none', async () => {
    scopes = [
      unsupported(
        '.',
        'no package.json, go.mod or Dockerfile in this directory.',
      ),
      detected('apps/hub', 'service', 'Bun — a start script is declared'),
      detected('apps/ddnsd', 'service', 'Go — go.mod is in this directory'),
      detected('apps/site', 'website', 'Astro — `astro` is a dependency'),
    ];

    const screen = await mount({
      ...clean,
      source: {
        kind: 'repo',
        repo: 'example/almanac',
        url: 'https://github.com/example/almanac.git',
        subpath: '.',
      },
    });
    const text = screen.text();

    for (const scope of ['apps/hub', 'apps/ddnsd', 'apps/site']) {
      expect(text).toContain(scope);
    }
    // The one it could not make sense of is here too, wearing what it found
    // instead of a sentence about the repository as a whole.
    expect(text).toContain('no package.json, go.mod or Dockerfile');
    // And nothing was chosen: the alphabetically first candidate is not the
    // answer, and Deploy waits for one.
    expect(text).toContain('Nothing is chosen to deploy from example/almanac');
    expect(text).toContain('Spindrift stops before Build #1');

    screen.unmount();
  });

  test('a sole candidate is a proposal rather than a question', async () => {
    scopes = [
      unsupported('.', 'nothing in the root'),
      detected('apps/only', 'service', 'Go — go.mod is in this directory'),
    ];

    const screen = await mount({
      ...clean,
      source: {
        kind: 'repo',
        repo: 'example/almanac',
        url: 'https://github.com/example/almanac.git',
        subpath: '.',
      },
    });
    const text = screen.text();

    expect(text).toContain('go.mod is in this directory');
    expect(text).not.toContain('Nothing is chosen');
    // The Component the proposal names, taken from the scope it was found in.
    expect(text).toContain('only');

    screen.unmount();
  });

  test('a directory it cannot build says what it found there instead', async () => {
    scopes = [unsupported('.', 'just prose in this directory.')];

    const screen = await mount({
      ...clean,
      source: {
        kind: 'repo',
        repo: 'example/almanac',
        url: 'https://github.com/example/almanac.git',
        subpath: '.',
      },
    });
    const text = screen.text();

    // The detail, not a generic sentence about the repository — and the row
    // opens itself so the list it refers to is on screen rather than behind an
    // Edit button.
    expect(text).toContain('does not know how to build . in example/almanac');
    expect(text).toContain('just prose in this directory.');
    expect(text).toContain('Directories Spindrift read');

    screen.unmount();
  });

  test('a repository it can build nothing in says so, with every directory listed', async () => {
    scopes = [
      unsupported('.', 'nothing in the root.'),
      unsupported('packages/ui', 'a library rather than an App.'),
    ];

    const screen = await mount({
      ...clean,
      source: {
        kind: 'repo',
        repo: 'example/almanac',
        url: 'https://github.com/example/almanac.git',
        subpath: 'apps/web',
      },
    });
    const text = screen.text();

    expect(text).toContain('found nothing it knows how to build');
    expect(text).toContain('a library rather than an App.');

    screen.unmount();
  });
});

/**
 * Reopening a draft is not correcting it.
 *
 * Drafts are durable rows reachable by URL (`/apps/new/:draftId`), so the read
 * that fills in a fresh draft runs again on every reload and every back
 * navigation. Applying its proposal the second time reverts what somebody
 * already decided — and the save that follows every action makes the reversion
 * permanent, which is what turns a cosmetic flicker into a draft that deploys a
 * different directory than the one on screen.
 */
describe('a draft somebody already answered', () => {
  test('a corrected kind and a typed Component survive the read on open', async () => {
    scopes = [
      detected('apps/api', 'service', 'Bun — a start script is declared'),
    ];

    const screen = await mount({
      ...clean,
      kind: 'job',
      componentName: 'api-worker',
      detection: {
        kind: 'service',
        reason: 'Bun — a start script is declared',
        available: ['service', 'website', 'job'],
        unavailable: {},
        scope: 'apps/api',
      },
      source: {
        kind: 'repo',
        repo: 'example/almanac',
        url: 'https://github.com/example/almanac.git',
        subpath: 'apps/api',
      },
    });

    // It still asks — the directories stay on screen to choose from.
    expect(called).toContain('inspectRepository');
    expect(screen.text()).toContain('api-worker · job');
    // And it wrote nothing, because it decided nothing.
    expect(saved).toEqual([]);

    screen.unmount();
  });

  test('a directory the operator typed is not swapped for the one candidate', async () => {
    // The sole-candidate proposal is the right answer for a draft nobody has
    // answered. Here somebody named `apps/ddnsd` — a directory this read has
    // nothing to say about — and moving them to `apps/hub` would deploy
    // somewhere they never asked for.
    scopes = [
      detected('apps/hub', 'service', 'Bun — a start script is declared'),
    ];

    const screen = await mount({
      ...clean,
      scopeByOperator: true,
      source: {
        kind: 'repo',
        repo: 'example/almanac',
        url: 'https://github.com/example/almanac.git',
        subpath: 'apps/ddnsd',
      },
    });

    expect(screen.text()).toContain('example/almanac · apps/ddnsd');
    expect(saved).toEqual([]);

    screen.unmount();
  });

  test('but choosing another repository is not a reopen', async () => {
    // The guard is durable state, which is what makes it survive the reload it
    // exists for — and what made it survive the picker. A second repository
    // arrived already answered by the first one's read, so nothing was applied
    // to it: the kind, the sentence and the ruled-out kinds stayed the previous
    // repository's, with no blocker and Deploy enabled.
    const answered = draftReducer(clean, {
      type: 'detect',
      scope: 'apps/api',
      kind: 'job',
      reason: 'a job is declared in spindrift.yaml',
      unavailable: { website: 'no static output is emitted here' },
    });
    const switched = draftReducer(answered, {
      type: 'repo',
      fullName: 'example/ledger',
      url: 'https://github.com/example/ledger.git',
    });
    const found = [detected('.', 'website', 'Astro — `astro` is a dependency')];

    expect(
      outcomeOf(switched, {
        fullName: 'example/ledger',
        scope: undefined,
        found,
        merged: found,
      }).act,
    ).toBe('detect');
  });

  test('a reason read elsewhere says which directory it is about', async () => {
    // The draft names `docs` and the sentence under Component was read in
    // `apps/api`. Rendering it bare would describe a directory nobody named.
    scopes = [
      detected('apps/api', 'service', 'Bun — a start script is declared'),
    ];

    const screen = await mount({
      ...clean,
      scopeByOperator: true,
      detection: {
        kind: 'service',
        reason: 'Bun — a start script is declared',
        available: ['service', 'website', 'job'],
        unavailable: {},
        scope: 'apps/api',
      },
      source: {
        kind: 'repo',
        repo: 'example/almanac',
        url: 'https://github.com/example/almanac.git',
        subpath: 'docs',
      },
    });

    expect(screen.text()).toContain('read in apps/api');
    expect(screen.text()).toContain('root directory now names docs');

    screen.unmount();
  });
});

/**
 * A read about one directory answers about that directory.
 *
 * This is the settled-subpath path — `onBlur`/Enter on the root directory
 * field — and the property is the whole of it: whatever comes back is about
 * the path that was named, so the reason on screen can never be a sentence
 * about somewhere else. The decision is exercised here rather than through the
 * mounted screen because the DOM shim deliberately has no event system
 * (`test/harness/dom.ts`); the request shape and the decision are what a
 * settled edit *is*.
 */
describe('a read about one directory', () => {
  const repo: Draft = {
    ...clean,
    source: {
      kind: 'repo',
      repo: 'example/almanac',
      url: 'https://github.com/example/almanac.git',
      subpath: 'docs',
    },
    scopeByOperator: true,
  };
  const known = [
    detected('apps/hub', 'service', 'Bun — a start script is declared'),
    detected('apps/site', 'website', 'Astro — `astro` is a dependency'),
  ];

  test('it names the directory rather than searching the tree', () => {
    expect(inspection('example/almanac', 'docs')).toEqual({
      fullName: 'example/almanac',
      scopes: ['docs'],
    });
    expect(inspection('example/almanac')).toEqual({
      fullName: 'example/almanac',
    });
  });

  test('its answer replaces that one row and leaves the rest standing', () => {
    const merged = mergeScopes(known, [
      detected('apps/hub', 'website', 'Astro — `astro` is a dependency'),
      unsupported('docs', 'just prose in this directory.'),
    ]);

    expect(merged.map((scope) => scope.scope)).toEqual([
      'apps/hub',
      'apps/site',
      'docs',
    ]);
    expect(merged[0]).toMatchObject({ kind: 'website' });
    expect(merged[1]).toEqual(known[1]!);
  });

  test('a directory it can build is what the draft takes', () => {
    const found = [
      detected('docs', 'website', 'Astro — `astro` is a dependency'),
    ];

    expect(
      outcomeOf(repo, {
        fullName: 'example/almanac',
        scope: 'docs',
        found,
        merged: mergeScopes(known, found),
      }),
    ).toEqual({
      act: 'detect',
      action: {
        type: 'detect',
        scope: 'docs',
        kind: 'website',
        reason: 'Astro — `astro` is a dependency',
        unavailable: { job: 'jobs are asserted, never inferred' },
      },
    });
  });

  test('one it cannot says so about that directory, and moves nothing', () => {
    const found = [unsupported('docs', 'just prose in this directory.')];
    const outcome = outcomeOf(repo, {
      fullName: 'example/almanac',
      scope: 'docs',
      found,
      merged: mergeScopes(known, found),
    });

    expect(outcome.act).toBe('refuse');
    expect(outcome.act === 'refuse' && outcome.message).toContain('docs');
    expect(outcome.act === 'refuse' && outcome.message).toContain(
      'just prose in this directory.',
    );
  });

  test('a sole candidate elsewhere is not an answer about the named directory', () => {
    // The snap-back: with one candidate in the repository, a settled edit to a
    // directory detection cannot build used to fall through to the candidate
    // and rewrite the path out from under whoever typed it.
    const found = [unsupported('docs', 'just prose in this directory.')];

    expect(
      outcomeOf(repo, {
        fullName: 'example/almanac',
        scope: 'docs',
        found,
        merged: mergeScopes([known[0]!], found),
      }).act,
    ).toBe('refuse');
  });
});
