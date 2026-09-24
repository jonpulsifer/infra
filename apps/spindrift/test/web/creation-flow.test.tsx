// An unmet prerequisite stops creation before any Build exists, keeps the draft
// and names the fix. `blockersFor` decides; the screen must say why, not only disable.
import { describe, expect, test } from 'bun:test';
import { sniffArchiveFormat } from '@repo/archive/archive-format';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  blockersFor,
  type Draft,
  draftReducer,
} from '../../src/web/views/apps/new/draft.ts';
import {
  CreationLoadFailure,
  CreationSkeleton,
  NewApp,
} from '../../src/web/views/apps/new/index.tsx';
import {
  INITIAL_DRAFT,
  REPOSITORY_GRANT,
  REPOSITORY_OPTIONS,
  TARGET_OPTIONS,
} from '../fixtures/scenarios.ts';
import { zipOf } from '../fixtures/zip.ts';
import { bytes, tar, tarball } from '../harness/tar.ts';

const CANDIDATES = TARGET_OPTIONS.filter((target) => target.candidate).map(
  (target) => target.targetId,
);

// Every prerequisite met; the other cases deviate from this.
const clean: Draft = {
  ...INITIAL_DRAFT,
  config: INITIAL_DRAFT.config.map((key) => ({ ...key, supplied: true })),
};

const render = (draft: Draft) =>
  renderToStaticMarkup(
    <NewApp
      initial={{
        id: crypto.randomUUID(),
        revision: 0,
        draft,
        blockers: blockersFor(draft, CANDIDATES),
        ready: blockersFor(draft, CANDIDATES).length === 0,
      }}
      targets={TARGET_OPTIONS}
      repos={REPOSITORY_OPTIONS}
      available={REPOSITORY_GRANT}
    />,
  );

describe('the preflight', () => {
  test('a complete draft has nothing standing in its way', () => {
    expect(blockersFor(clean, CANDIDATES)).toEqual([]);
  });

  test('an unprovisioned vessel blocks, and says who provisions it', () => {
    // Vessels are pre-provisioned through Terraform, so the fix is someone else's merge.
    const blockers = blockersFor(
      { ...clean, vessel: { ...clean.vessel, ready: false } },
      CANDIDATES,
    );
    expect(blockers).toHaveLength(1);
    expect(blockers[0]!.remediation).toContain('Terraform');
  });

  test('a non-candidate Target blocks', () => {
    const excluded = TARGET_OPTIONS.find((target) => !target.candidate)!;
    const blockers = blockersFor(
      { ...clean, targetId: excluded.targetId },
      CANDIDATES,
    );
    expect(blockers).toHaveLength(1);
    expect(blockers[0]!.title).toContain('Nothing chosen can run this App');
  });

  test('a config key with no value blocks, and names the key', () => {
    // Config values are write-only, so this screen cannot fill an empty key later.
    const blockers = blockersFor(INITIAL_DRAFT, CANDIDATES);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]!.remediation).toContain('DATABASE_URL');
  });

  test('several unmet prerequisites are all reported', () => {
    const blockers = blockersFor(
      { ...INITIAL_DRAFT, vessel: { ...clean.vessel, ready: false } },
      CANDIDATES,
    );
    expect(blockers.length).toBeGreaterThan(1);
  });
});

describe('the screen shows the preflight rather than only obeying it', () => {
  test('a blocked draft states what is wrong and what clears it', () => {
    const markup = render(INITIAL_DRAFT);

    expect(markup).toContain('to fix above');
    expect(markup).toContain('DATABASE_URL');
    expect(markup).toContain('Nothing has been created');
    expect(markup).toContain('this draft is kept');
  });

  test('and the button that would start a Build is off', () => {
    expect(render(INITIAL_DRAFT)).toContain('disabled');
  });

  test('a clean draft offers the Build instead', () => {
    const markup = render(clean);

    expect(markup).toContain('locks where it runs');
    expect(markup).toContain('Deploy');
    expect(markup).not.toContain('Nothing has been created');
  });
});

describe('the whole plan is four rows', () => {
  const markup = render(clean);

  test('every decision is answered before anything is pressed', () => {
    // Reach, Auth, Target, URL and Vessel are one sentence under `Where it runs`.
    for (const label of ['Code', 'Type', 'Name', 'Where it runs']) {
      expect(markup).toContain(label);
    }
  });

  test('and the five infrastructure nouns are not on the top line', () => {
    // Each is inside `Where it runs`, which is closed here.
    for (const noun of ['Vessel', 'Adapter', 'rank ', 'Reach']) {
      expect(markup).not.toContain(noun);
    }
  });

  test('no step rail survives', () => {
    expect(markup).not.toContain('Continue');
    expect(markup).not.toContain('aria-current="step"');
  });

  test('the vessel is marked immutable while it is still a choice', () => {
    // A row holding an unmet prerequisite opens itself.
    const excluded = TARGET_OPTIONS.find((target) => !target.candidate)!;
    const markup = render({ ...clean, targetId: excluded.targetId });

    expect(markup).toContain('fixed once the App is created');
    expect(markup).toContain('Nothing chosen can run this App');
  });
});

describe('an App nothing routes to', () => {
  test('states that it has no address, rather than printing one', () => {
    // The Target mints a hostname whatever the reach; whether one applies is the draft's answer.
    const markup = render({ ...clean, reach: 'none' });

    expect(markup).toContain('no address');
    expect(markup).toContain('Nothing routes to it');
    expect(markup).not.toContain('.apps.example');
  });

  test('and an App that is reachable still shows the address it will get', () => {
    expect(render(clean)).toContain('.apps.example');
  });
});

describe('while the screen is still loading', () => {
  test('the placeholder is the rows that are coming, not one pulsing line', () => {
    const markup = renderToStaticMarkup(<CreationSkeleton phase="draft" />);
    for (const label of ['Code', 'Type', 'Name', 'Where it runs']) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain('aria-busy="true"');
  });

  test('it names which of the two reads is outstanding', () => {
    // Placement is resolved for the draft, so the second read waits on the first.
    expect(renderToStaticMarkup(<CreationSkeleton phase="draft" />)).toContain(
      'Recovering the draft',
    );
    expect(
      renderToStaticMarkup(<CreationSkeleton phase="options" />),
    ).toContain('Targets and repositories');
  });
});

describe('a field the schema will refuse', () => {
  // The screen reads the same rule as `creationDraftSchema`.
  const markup = render({ ...clean, appName: 'Almanac Staging' });

  test('is marked where the value is', () => {
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('must be lowercase letters, digits and hyphens');
  });

  test('and a good one is not', () => {
    expect(render(clean)).not.toContain('aria-invalid');
  });

  test('the Component name carries the schema’s rule too', () => {
    // An empty name is the only thing `componentNameSchema` refuses.
    expect(render({ ...clean, componentName: '' })).toContain(
      'the Component needs a name',
    );
  });
});

describe('when neither read answered', () => {
  const markup = renderToStaticMarkup(
    <CreationLoadFailure
      message="the database was unreachable"
      onRetry={() => {}}
    />,
  );

  test('the failure is named and retryable', () => {
    // Every read behind this screen is idempotent, so a retry is always safe.
    expect(markup).toContain('the database was unreachable');
    expect(markup).toContain('Try again');
  });
});

describe('non-candidate Targets are listed rather than hidden', () => {
  // Listed, disabled and annotated with why. The Target row opens itself when
  // the chosen Target is excluded.
  const excluded = TARGET_OPTIONS.find((target) => !target.candidate)!;
  const markup = render({ ...clean, targetId: excluded.targetId });

  test('every connected Target appears, candidate or not', () => {
    for (const target of TARGET_OPTIONS) {
      expect(markup).toContain(target.vessel);
    }
  });

  test('each exclusion carries its reason and its sentence', () => {
    for (const target of TARGET_OPTIONS.filter((option) => !option.candidate)) {
      for (const reason of target.reasons) expect(markup).toContain(reason);
      for (const detail of target.detail) expect(markup).toContain(detail);
    }
  });

  test('a settled Target keeps its alternatives out of the way', () => {
    const settled = render(clean);
    const other = TARGET_OPTIONS.find(
      (target) => target.targetId !== clean.targetId,
    )!;
    expect(settled).not.toContain(other.canonical);
  });
});

describe('the draft reducer', () => {
  test('a tile that names a kind preselects it', () => {
    // `website` is ruled out on the shared fixture, so this draft allows it.
    const openToWebsite: Draft = {
      ...INITIAL_DRAFT,
      kind: 'job',
      detection: {
        ...INITIAL_DRAFT.detection,
        available: ['service', 'website', 'job'],
        unavailable: {},
      },
    };
    const next = draftReducer(openToWebsite, {
      type: 'entry',
      entry: 'website',
    });
    expect(next.kind).toBe('website');
    // A kind tile leaves the source alone.
    expect(next.source).toEqual(INITIAL_DRAFT.source);
  });

  test('a tile naming a kind detection ruled out does not select it', () => {
    // Otherwise the kind would show as selected and disabled at once.
    expect(INITIAL_DRAFT.detection.unavailable.website).toBeDefined();
    const next = draftReducer(INITIAL_DRAFT, {
      type: 'entry',
      entry: 'website',
    });
    expect(next.kind).toBe(INITIAL_DRAFT.kind);
  });

  test('a tile that names no kind leaves the draft’s kind standing', () => {
    // The kind may be the operator's correction, not detection's proposal.
    const corrected: Draft = { ...INITIAL_DRAFT, kind: 'job' };
    const next = draftReducer(corrected, { type: 'entry', entry: 'upload' });
    expect(next.kind).toBe('job');
  });

  test('the Upload tile switches the source to an archive', () => {
    const next = draftReducer(INITIAL_DRAFT, {
      type: 'entry',
      entry: 'upload',
    });
    expect(next.source.kind).toBe('archive');
  });

  // A draft that has only ever been an upload, as on a fresh install.
  const uploadOnly: Draft = {
    ...INITIAL_DRAFT,
    entry: 'upload',
    source: {
      kind: 'archive',
      filename: 'upload.zip',
      digest: `sha256:${'0'.repeat(64)}`,
      location: null,
      contents: 'source',
      subpath: '.',
    },
  };

  test('the repo tiles open on a picker when no repository has been named', () => {
    const linking = draftReducer(uploadOnly, { type: 'entry', entry: 'repo' });

    expect(linking.source).toMatchObject({ kind: 'repo', repo: '' });
    expect(
      blockersFor(linking, CANDIDATES).map((blocker) => blocker.title),
    ).toContain('No repository is chosen.');
  });

  test('discovering is linking a repo, with its directories to choose from', () => {
    const next = draftReducer(uploadOnly, { type: 'entry', entry: 'discover' });
    expect(next.source.kind).toBe('repo');
  });

  test('a staged archive survives a look at the repo tiles', () => {
    const staged = draftReducer(uploadOnly, {
      type: 'archive',
      filename: 'dist.zip',
      digest: `sha256:${'a'.repeat(64)}`,
      location: 'https://bundles.example.test/dist.zip',
    });
    const back = draftReducer(
      draftReducer(staged, { type: 'entry', entry: 'repo' }),
      { type: 'entry', entry: 'upload' },
    );

    expect(back.source).toMatchObject({
      kind: 'archive',
      location: 'https://bundles.example.test/dist.zip',
    });
  });

  test('and so does the repository that was picked', () => {
    const back = draftReducer(
      draftReducer(INITIAL_DRAFT, { type: 'entry', entry: 'upload' }),
      { type: 'entry', entry: 'repo' },
    );

    expect(back.source).toEqual(INITIAL_DRAFT.source);
  });

  test('a detection replaces the proposal, the kind, and the scope together', () => {
    const next = draftReducer(INITIAL_DRAFT, {
      type: 'detect',
      scope: 'apps/web',
      kind: 'website',
      reason: 'Astro — `astro` is a dependency in package.json',
      unavailable: { job: 'jobs are asserted, never inferred' },
    });

    expect(next.kind).toBe('website');
    expect(next.detection.reason).toContain('Astro');
    expect(next.detection.available).toEqual(['service', 'website']);
    expect(next.detection.unavailable.job).toBeDefined();
    expect(next.componentName).toBe('web');
    expect(next.source.kind === 'repo' && next.source.subpath).toBe('apps/web');
    // A reopened draft tells a read directory from an unread one by this scope.
    expect(next.detection.scope).toBe('apps/web');
  });

  test('a detection overrides a corrected kind, because it is about a new directory', () => {
    // A kind answers for a directory; the App name, which survives, answers for the App.
    const corrected = draftReducer(INITIAL_DRAFT, {
      type: 'kind',
      kind: 'job',
    });
    const next = draftReducer(corrected, {
      type: 'detect',
      scope: '.',
      kind: 'website',
      reason: 'a fresh read',
      unavailable: {},
    });

    expect(next.kind).toBe('website');
  });

  test('a repository nobody named derives the App name from it', () => {
    const next = draftReducer(INITIAL_DRAFT, {
      type: 'repo',
      fullName: 'example/ledger',
      url: 'https://github.com/example/ledger.git',
    });
    expect(next.appName).toBe('ledger');
  });

  test('an App name the operator typed survives re-selecting the repository', () => {
    const named = draftReducer(INITIAL_DRAFT, {
      type: 'field',
      field: 'appName',
      value: 'almanac-staging',
    });
    const reselected = draftReducer(named, {
      type: 'repo',
      fullName: 'example/ledger',
      url: 'https://github.com/example/ledger.git',
    });
    const redetected = draftReducer(reselected, {
      type: 'detect',
      scope: 'apps/api',
      kind: 'service',
      reason: 'a fresh read',
      unavailable: {},
    });

    expect(reselected.appName).toBe('almanac-staging');
    expect(redetected.appName).toBe('almanac-staging');
  });

  test('selecting a repository the grant offers marks it to connect on Deploy', () => {
    const next = draftReducer(INITIAL_DRAFT, {
      type: 'repo',
      fullName: 'example/ledger',
      url: 'https://github.com/example/ledger.git',
      connect: true,
    });
    expect(next.source).toMatchObject({ connect: true, subpath: '.' });
  });

  test('another repository is another tree, so the directory resets', () => {
    const named = draftReducer(INITIAL_DRAFT, {
      type: 'subpath',
      subpath: 'apps/ddnsd',
    });
    const next = draftReducer(named, {
      type: 'repo',
      fullName: 'example/ledger',
      url: 'https://github.com/example/ledger.git',
    });
    expect(next.source.kind === 'repo' && next.source.subpath).toBe('.');
    // The root is nobody's answer, so the next read may propose a directory.
    expect(next.scopeByOperator).toBeUndefined();
  });

  test('another repository is another read, so the detection resets', () => {
    // `outcomeOf` reads the scope, so a stale one would make the new
    // repository's read apply nothing.
    const read = draftReducer(INITIAL_DRAFT, {
      type: 'detect',
      scope: 'apps/api',
      kind: 'job',
      reason: 'a job is declared in spindrift.yaml',
      unavailable: { website: 'no static output is emitted here' },
    });
    const next = draftReducer(read, {
      type: 'repo',
      fullName: 'example/ledger',
      url: 'https://github.com/example/ledger.git',
    });

    expect(next.detection.scope).toBeUndefined();
    expect(next.detection.unavailable).toEqual({});
    expect(next.detection.available).toEqual(['service', 'website', 'job']);
    expect(next.detection.reason).not.toContain('spindrift.yaml');
  });

  test('a directory the operator settled on is recorded as theirs', () => {
    // Stored on the draft: the guard it feeds runs when a saved draft is reopened.
    const next = draftReducer(INITIAL_DRAFT, {
      type: 'subpath',
      subpath: 'apps/ddnsd',
      settled: true,
    });
    expect(next.scopeByOperator).toBe(true);
  });

  test('a directory still being typed is not yet an answer', () => {
    // Otherwise a half-typed path would clear the prerequisite and enable Deploy.
    const next = draftReducer(INITIAL_DRAFT, {
      type: 'subpath',
      subpath: 'a',
    });
    expect(next.source).toMatchObject({ subpath: 'a' });
    expect(next.scopeByOperator).toBe(INITIAL_DRAFT.scopeByOperator);
  });
});

// `accept` is a hand-written claim about `@repo/archive/archive-format`, which
// sniffs magic numbers, not filenames. Only this test ties the two together.
describe('the archive chooser', () => {
  // Real bytes of the container each extension names.
  const SAMPLES: Record<string, Uint8Array> = {
    '.zip': zipOf([{ path: 'index.html', text: 'hi' }]),
    '.tar.gz': tarball([{ name: 'index.html', bytes: bytes('hi') }]),
    '.tgz': tarball([{ name: 'index.html', bytes: bytes('hi') }]),
    // Not offered: a plain tar has no magic number the boundary reads.
    '.tar': tar([{ name: 'index.html', bytes: bytes('hi') }]),
  };

  test('offers only containers the upload boundary accepts', () => {
    const markup = render(
      draftReducer(clean, { type: 'entry', entry: 'upload' }),
    );
    const offered = [...markup.matchAll(/accept="([^"]*)"/g)].flatMap((match) =>
      (match[1] ?? '').split(','),
    );
    // The picker renders only on an archive source; zero would make this vacuous.
    expect(offered.length).toBeGreaterThan(0);

    const unsampled: string[] = [];
    const refused: string[] = [];
    for (const extension of offered) {
      const sample = SAMPLES[extension];
      // A newly offered extension needs a sample here first.
      if (sample === undefined) unsampled.push(extension);
      else if (sniffArchiveFormat(sample) === null) refused.push(extension);
    }
    expect({ unsampled, refused }).toEqual({ unsampled: [], refused: [] });
  });
});
