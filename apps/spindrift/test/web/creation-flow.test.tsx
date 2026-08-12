/**
 * The creation flow's one hard rule (Task 38): **an unmet prerequisite stops
 * before any Build exists**, keeps the draft, and names the remediation path.
 *
 * Two halves, and both matter. `blockersFor` decides — it is ordinary logic and
 * is tested as such. The screen then has to *show* the decision: a disabled
 * button with no sentence beside it is the failure mode this rule exists to
 * prevent, because it leaves the developer with nothing to act on.
 *
 * The flow is one screen now, so there is no step to put a draft on before
 * asserting: everything is rendered at once and the assertions are about what
 * is on it. That is itself a property worth holding — a preflight you have to
 * navigate to is a preflight somebody can be surprised by.
 */
import { describe, expect, test } from 'bun:test';
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

const CANDIDATES = TARGET_OPTIONS.filter((target) => target.candidate).map(
  (target) => target.targetId,
);

/** A draft with every prerequisite met — the baseline the others deviate from. */
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
    // §14 and Task 46: vessels are pre-provisioned through Terraform, and
    // Spindrift never creates a project. So the remediation is somebody else's
    // merge, and saying that is the difference between waiting and retrying.
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
    expect(blockers[0]!.title).toContain('not a candidate');
  });

  test('a config key with no value blocks, and names the key', () => {
    // §10 makes values write-only, so a key left empty here cannot be filled in
    // later from this screen. That is why it is a blocker rather than a warning.
    const blockers = blockersFor(INITIAL_DRAFT, CANDIDATES);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]!.remediation).toContain('DATABASE_URL');
  });

  test('several unmet prerequisites are all reported', () => {
    // Reporting one at a time turns a blocked draft into a guessing game.
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

    expect(markup).toContain('Spindrift stops before Build #1');
    expect(markup).toContain('DATABASE_URL');
    expect(markup).toContain('Nothing has been created');
    // The draft survives — the rule is "stops before any Build exists", not
    // "discards what the developer entered".
    expect(markup).toContain('This draft is kept');
  });

  test('and the button that would start a Build is off', () => {
    expect(render(INITIAL_DRAFT)).toContain('disabled');
  });

  test('a clean draft offers the Build instead', () => {
    const markup = render(clean);

    expect(markup).toContain('locks its vessel');
    expect(markup).toContain('Deploy');
    expect(markup).not.toContain('Nothing has been created');
  });
});

describe('the whole plan is on one screen', () => {
  const markup = render(clean);

  test('every decision is answered before anything is pressed', () => {
    // Source, Component, Target, URL, Reach, Vessel — the five §18 decisions,
    // as rows that already say what will happen.
    for (const label of [
      'Source',
      'Component',
      'Target',
      'URL',
      'Reach',
      'Vessel',
    ]) {
      expect(markup).toContain(label);
    }
  });

  test('no step rail survives', () => {
    // The regression this guards is the flow growing its Continue buttons
    // back: four presses to accept four answers nobody disagreed with.
    expect(markup).not.toContain('Continue');
    expect(markup).not.toContain('aria-current="step"');
  });

  test('the vessel is marked immutable while it is still a choice', () => {
    expect(markup).toContain('immutable once created');
  });
});

describe('while the screen is still loading', () => {
  test('the placeholder is the rows that are coming, not one pulsing line', () => {
    // A card of six rows arrives as a card of six rows. The alternative is a
    // sentence that says nothing about what will be on the screen, followed by
    // a layout shift that costs the reader their place.
    const markup = renderToStaticMarkup(<CreationSkeleton phase="draft" />);
    for (const label of [
      'Source',
      'Component',
      'Target',
      'URL',
      'Reach',
      'Vessel',
    ]) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain('aria-busy="true"');
  });

  test('it names which of the two reads is outstanding', () => {
    // The second read cannot start until the first has answered — placement is
    // resolved for the draft (§3) — so "loading" means two different waits.
    expect(renderToStaticMarkup(<CreationSkeleton phase="draft" />)).toContain(
      'Recovering the draft',
    );
    expect(
      renderToStaticMarkup(<CreationSkeleton phase="options" />),
    ).toContain('Targets and repositories');
  });
});

describe('a field the schema will refuse', () => {
  // The rule is one statement, in `creationDraftSchema`, read from both ends.
  // Before this the only surface for it was the transport refusal the save
  // came back with, rendered under the Deploy button as `appName: must be
  // lowercase…` — the right fact, as far from the input as the page allows.
  const markup = render({ ...clean, appName: 'Almanac Staging' });

  test('is marked where the value is', () => {
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('must be lowercase letters, digits and hyphens');
  });

  test('and a good one is not', () => {
    expect(render(clean)).not.toContain('aria-invalid');
  });

  test('the Component name carries the schema’s rule too', () => {
    // Whatever rule the schema states, and no rule it does not: an empty name
    // is the only thing `componentName` refuses.
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
    // Every read behind this screen is idempotent, so a dead end here is a
    // choice rather than a consequence.
    expect(markup).toContain('the database was unreachable');
    expect(markup).toContain('Try again');
  });
});

describe('non-candidate Targets are listed rather than hidden', () => {
  // §3's grammar: listed, disabled, and annotated with why. An empty list is
  // what makes "nowhere fits" unreadable — and so is a list behind a
  // disclosure, which is why the Target row opens itself when the chosen
  // Target is not one.
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
    // The other half of the same rule: when the answer is fine, the list of
    // other answers is noise.
    const settled = render(clean);
    const other = TARGET_OPTIONS.find(
      (target) => target.targetId !== clean.targetId,
    )!;
    expect(settled).not.toContain(other.canonical);
  });
});

describe('the draft reducer', () => {
  test('a tile that names a kind preselects it', () => {
    // `website` is ruled out on the shared fixture, which is a different case
    // — see below — so this is asked about a kind detection allows.
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
    // …and leaves the source alone: `Service` and `Website` name a kind, not a
    // place to get the code from.
    expect(next.source).toEqual(INITIAL_DRAFT.source);
  });

  test('a tile naming a kind detection ruled out does not select it', () => {
    // The Component row draws that kind disabled, wearing the reason it cannot
    // be chosen (§3). A tile that wrote it anyway produced the one state the
    // grammar has no reading for: selected and greyed at once.
    expect(INITIAL_DRAFT.detection.unavailable.website).toBeDefined();
    const next = draftReducer(INITIAL_DRAFT, {
      type: 'entry',
      entry: 'website',
    });
    expect(next.kind).toBe(INITIAL_DRAFT.kind);
  });

  test('a tile that names no kind leaves the draft’s kind standing', () => {
    // Not detection's kind — the operator's, if they corrected it. Reverting to
    // the proposal on a press about where the *source* comes from undid a
    // correction made two rows down and took its "corrected" badge with it.
    const corrected: Draft = { ...INITIAL_DRAFT, kind: 'job' };
    const next = draftReducer(corrected, { type: 'entry', entry: 'upload' });
    expect(next.kind).toBe('job');
  });

  test('the Upload tile switches the source to an archive', () => {
    // The defect this pins: the tile set an entry and a kind and nothing else,
    // so pressing it from a repository draft left the repository picker on
    // screen and the draft still deploying from a repository.
    const next = draftReducer(INITIAL_DRAFT, {
      type: 'entry',
      entry: 'upload',
    });
    expect(next.source.kind).toBe('archive');
  });

  /** A draft that has only ever been an upload — the fresh-install shape. */
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
    // Which is a draft nothing can be created from, said out loud rather than
    // discovered at Deploy.
    expect(
      blockersFor(linking, CANDIDATES).map((blocker) => blocker.title),
    ).toContain('No repository is chosen.');
  });

  test('discovering is linking a repo, with its directories to choose from', () => {
    const next = draftReducer(uploadOnly, { type: 'entry', entry: 'discover' });
    expect(next.source.kind).toBe('repo');
  });

  test('a staged archive survives a look at the repo tiles', () => {
    // Pressing the other tile is a look. Costing somebody a staged upload for
    // it is how a tile becomes one nobody presses twice.
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
    // The scope names the Component, and the source follows it.
    expect(next.componentName).toBe('web');
    expect(next.source.kind === 'repo' && next.source.subpath).toBe('apps/web');
    // And the reason records the directory it is about, so a draft reopened
    // later can tell "already read" from "never asked" without a string match
    // on the placeholder sentence.
    expect(next.detection.scope).toBe('apps/web');
  });

  test('a detection overrides a corrected kind, because it is about a new directory', () => {
    // Still true of the *kind*, and deliberately not of the App name below: a
    // kind is an answer about a directory, so an answer about a different
    // directory replaces it. A name is an answer about the App.
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
    // With the claim on it: the root is nobody's word, so the next read of the
    // new tree is free to propose one.
    expect(next.scopeByOperator).toBeUndefined();
  });

  test('another repository is another read, so the detection resets', () => {
    // The scope is what `outcomeOf` reads to decide a draft has been answered.
    // Carried across a repository change, the read of the repository just
    // chosen applies nothing and the rows below keep describing the previous
    // one — a kind, a sentence, and ruled-out kinds from somewhere else.
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
    // Durable rather than session state, because the guard it feeds is about
    // the read that runs when a saved draft is reopened.
    const next = draftReducer(INITIAL_DRAFT, {
      type: 'subpath',
      subpath: 'apps/ddnsd',
      settled: true,
    });
    expect(next.scopeByOperator).toBe(true);
  });

  test('a directory still being typed is not yet an answer', () => {
    // The keystroke that took `a` for an answer cleared the prerequisite that
    // says nothing has been chosen to deploy, and once the debounced save
    // landed Deploy went green for a path nothing had read.
    const next = draftReducer(INITIAL_DRAFT, {
      type: 'subpath',
      subpath: 'a',
    });
    expect(next.source).toMatchObject({ subpath: 'a' });
    expect(next.scopeByOperator).toBe(INITIAL_DRAFT.scopeByOperator);
  });
});
