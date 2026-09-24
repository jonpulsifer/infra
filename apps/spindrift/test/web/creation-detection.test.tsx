// Mounted, because detection runs from an effect. The creation screen asks
// `inspectRepository` on open, lists every directory it read, picks none of
// several, and does not re-apply a proposal when a draft is reopened.
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
  buildCommand: null,
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

// What `inspectRepository` answers.
let scopes: readonly InspectedScope[] = [];
let called: string[] = [];
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
        // What the screen decided alone shows only in what it wrote back.
        saved.push((JSON.parse(init.body) as { draft: Draft }).draft);
        return {
          json: async () => ({
            ok: true,
            value: { id: 'draft', revision: 1, draft: null, blockers: [] },
          }),
        };
      }
      // `listTargets` re-resolves placement when detection moves the kind.
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

  test('a draft nobody has pointed anywhere reads nothing, and asks', async () => {
    // `startCreationDraft` preselects no repository.
    const screen = await mount({
      ...clean,
      source: { kind: 'repo', repo: '', url: '', subpath: '.' },
    });

    expect(called).not.toContain('inspectRepository');
    const text = screen.text();
    expect(text).toContain('Import your code');
    // Both tiles are on this page, so the header names neither.
    expect(text).toContain('Upload an archive');
    // None of the plan rows is on screen yet.
    for (const row of ['Code', 'Type', 'Where it runs']) {
      expect(text).not.toContain(row);
    }
    expect(text).not.toContain('Root directory');

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
    expect(text).toContain('no package.json, go.mod or Dockerfile');
    // Not even the alphabetically first candidate is chosen.
    expect(text).toContain('Nothing is chosen to deploy from example/almanac');
    expect(text).toContain('to fix above');

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
    // The proposed Component is named after its scope.
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

    // The row opens itself, so the directory list is on screen.
    expect(text).toContain('does not know how to build . in example/almanac');
    expect(text).toContain('just prose in this directory.');
    expect(text).toContain('Directories in this repo');

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

// Drafts reopen by URL, so the read that fills a fresh draft runs again.
// Re-applying its proposal would revert, and then save, what someone decided.
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

    expect(called).toContain('inspectRepository');
    const text = screen.text();
    expect(text).toContain('TypeJob');
    expect(text).toContain('corrected');
    // Applying the read would rename `api-worker` after the scope and save, so
    // no save means the typed name stands.
    expect(saved).toEqual([]);

    screen.unmount();
  });

  test('a directory the operator typed is not swapped for the one candidate', async () => {
    // The sole candidate is proposed only for a draft nobody has answered.
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
    // The guard is stored on the draft, so it must reset with the repository or
    // the new repository's read would apply nothing.
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
    // The draft names `docs`, but the reason was read in `apps/api`.
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

// A settled edit to the root directory field reads that one path. Tested as a
// decision, because the DOM shim has no event system.
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
    // Falling through to the sole candidate would rewrite the typed path.
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
