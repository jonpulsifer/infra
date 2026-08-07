/**
 * What the creation screen does with what detection found, mounted.
 *
 * These are claims about the screen's *behaviour* rather than its markup, and
 * behaviour here is one effect and one command call: the wizard opens claiming
 * a kind, and until something asks `inspectRepository` that claim is the
 * default nobody chose. A static render cannot observe an effect, so this file
 * mounts the screen and answers its one read.
 *
 * Three properties, and they are the three ways this went wrong before:
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

const detected = (scope: string, kind: string, reason: string) => ({
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

const unsupported = (scope: string, detail: string) => ({
  scope,
  outcome: 'unsupported',
  detail,
});

/** What `inspectRepository` answers, per test. */
let scopes: readonly unknown[] = [];
/** Every command the screen called, in order. */
let called: string[] = [];

let dom: DomShim;

beforeAll(() => {
  dom = installDomShim({
    fetch: async (url: string) => {
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
