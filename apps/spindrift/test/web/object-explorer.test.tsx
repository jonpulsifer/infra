import { describe, expect, test } from 'bun:test';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  AppListItem,
  BuildListItem,
  DeployLedgerItem,
} from '../../src/commands/views.ts';
import type {
  AppDeletion,
  AppDeletionControls,
} from '../../src/web/components/delete-app.tsx';
import { ObjectExplorer } from '../../src/web/components/object-explorer.tsx';
import { AppShell } from '../../src/web/components/shell.tsx';
import { AppList } from '../../src/web/views/apps/list.tsx';
import { DeployLedger } from '../../src/web/views/operations/deploys.tsx';
import { Overview } from '../../src/web/views/operations/overview.tsx';
import { SettingsLayout } from '../../src/web/views/settings/layout.tsx';
import { ArtifactLedger } from '../../src/web/views/supply-chain/artifacts.tsx';
import { BuildLedger } from '../../src/web/views/supply-chain/builds.tsx';
import {
  SourceLedger,
  type SourceListItem,
} from '../../src/web/views/supply-chain/sources.tsx';

describe('the object-first shell', () => {
  test('keeps the operational ledgers and Settings in the primary rail', () => {
    const markup = renderToStaticMarkup(
      <AppShell
        path="/builds"
        principal={{ id: 'operator', displayName: 'Ada Operator' }}
        onNavigate={() => undefined}
        onSignOut={() => undefined}
        themeControl={<span>theme</span>}
      >
        <p>ledger</p>
      </AppShell>,
    );

    for (const label of ['Overview', 'Apps', 'Builds', 'Deploys', 'Settings']) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain('SPINDRIFT /');
    expect(markup).toContain('aria-current="page"');
  });

  test('renders a stable list beside the selected object inspector', () => {
    const markup = renderToStaticMarkup(
      <ObjectExplorer
        items={[
          {
            id: 'one',
            title: 'Morrow',
            detail: 'service · Folly',
            status: 'live',
            tone: 'success',
          },
          {
            id: 'two',
            title: 'Beacon',
            detail: 'website · Cloud',
            status: 'building',
            tone: 'accent',
            active: true,
          },
        ]}
        filterPlaceholder="Filter objects…"
        empty={<p>empty</p>}
        renderInspector={(item) => <h2>Inspecting {item.title}</h2>}
      />,
    );

    expect(markup).toContain('aria-label="Objects"');
    expect(markup).toContain('Filter objects');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('Inspecting Morrow');
    expect(markup).toContain('Morrow inspector');
  });

  test('nests connection management under the Settings sections', () => {
    const markup = renderToStaticMarkup(
      <SettingsLayout section="connections" onNavigate={() => undefined}>
        <p>real connector controls</p>
      </SettingsLayout>,
    );

    for (const label of [
      'Connections',
      'Identity',
      'Installation',
      'Notifications',
      'Danger zone',
    ]) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain('real connector controls');
    // The section that held source buckets, staged bundles and registries.
    // Buckets and registries are connections; the bundles were Sources, and
    // both nouns are supply-chain ledgers — nothing is left for a policy tab.
    expect(markup).not.toContain('Artifact policy');
  });
});

describe('the global operation ledgers', () => {
  const build: BuildListItem = {
    id: 1837,
    appId: 'app-morrow',
    app: 'morrow',
    componentId: 'component-web',
    component: 'web',
    commit: '5bc1000000000000000000000000000000000000',
    targetShape: 'image',
    artifactType: 'image',
    artifactDigest: 'sha256:abc',
    status: 'SUCCEEDED',
    runner: 'Cloud Build',
    when: '13m ago',
    at: '2026-08-03T12:31:00.000Z',
    deployId: 993,
    dispatchWaitingOn: null,
  };
  const deploy: DeployLedgerItem = {
    id: 993,
    appId: 'app-morrow',
    app: 'morrow',
    buildId: build.id,
    componentId: build.componentId,
    component: build.component,
    targetId: 'target-folly',
    target: 'Folly',
    phase: 'APPLYING',
    commit: build.commit,
    configVersion: '9e2bc1',
    when: 'active',
    at: '2026-08-03T12:44:00.000Z',
    current: true,
    rollbackable: false,
  };

  test('keeps Build artifact facts on the Build explorer', () => {
    const markup = renderToStaticMarkup(
      <BuildLedger builds={[build]} onNavigate={() => undefined} />,
    );
    expect(markup).toContain('Build ledger');
    expect(markup).toContain('Cloud Build');
    expect(markup).toContain('sha256:abc');
    expect(markup).toContain('Loading Build evidence');
    // Builds is one of three supply-chain surfaces, and says so: the Artifact
    // it produced is its own noun on its own tab.
    expect(markup).toContain('Supply chain');
    expect(markup).toContain('Artifacts');
  });

  test('keeps placement facts on the Deploy explorer', () => {
    const markup = renderToStaticMarkup(
      <DeployLedger deploys={[deploy]} onNavigate={() => undefined} />,
    );
    expect(markup).toContain('Placement ledger');
    expect(markup).toContain('Folly');
    expect(markup).toContain('applying');
    expect(markup).toContain('Loading Deploy evidence');
  });

  /**
   * The two nouns either side of a Build. Each says what it *is* rather than
   * what happened to it: a Source names its origin and whether a builder could
   * still fetch it, an Artifact names how many Deploys have placed it.
   */
  test('a Source reads as staged bytes, not as the Build that used them', () => {
    const markup = renderToStaticMarkup(
      <SourceLedger
        limit={50}
        sources={[
          {
            digest: `sha256:${'a'.repeat(64)}`,
            origin: 'upload',
            repository: null,
            commit: null,
            commitMessage: null,
            commitAuthor: null,
            commitAuthoredAt: null,
            location: `upload://${'a'.repeat(64)}`,
            fetchable: false,
            retention: 'durable',
            app: 'morrow',
            component: 'web',
            builds: 2,
            latestBuildId: 1837,
            supplied: true,
            at: '2026-08-03T12:31:00.000Z',
          },
        ]}
        onNavigate={() => undefined}
      />,
    );
    expect(markup).toContain('Source ledger');
    expect(markup).toContain('durable');
    expect(markup).toContain('supplied artifact');
    expect(markup).toContain('no builder can fetch this');
  });

  test('an Artifact reads as what is placed, including when nothing is', () => {
    const markup = renderToStaticMarkup(
      <ArtifactLedger
        limit={50}
        artifacts={[
          {
            digest: `sha256:${'b'.repeat(64)}`,
            type: 'image',
            refs: ['ghcr.io/an-owner/morrow'],
            app: 'morrow',
            component: 'web',
            buildId: 1837,
            sourceDigest: `sha256:${'a'.repeat(64)}`,
            commit: '5bc1000000000000000000000000000000000000',
            provenanceLevel: 3,
            signed: true,
            supplied: false,
            deploys: 0,
            at: '2026-08-03T12:31:00.000Z',
          },
        ]}
        onNavigate={() => undefined}
      />,
    );
    expect(markup).toContain('Artifact ledger');
    expect(markup).toContain('never placed');
    expect(markup).toContain('SLSA L3');
    expect(markup).toContain('ghcr.io/an-owner/morrow');
  });

  /**
   * The ledgers are tables now, and the point of a table is the columns: the
   * facts these rows carried and did not show were flattened into one `·`
   * sentence nobody could sort, align or compare down.
   */
  test('a ledger row is a table row with the facts it used to hide', () => {
    const markup = renderToStaticMarkup(
      <BuildLedger builds={[build]} onNavigate={() => undefined} />,
    );
    expect(markup).toContain('<table');
    expect(markup).toContain('scope="col"');
    for (const header of ['Runner', 'Shape', 'Artifact', 'Commit']) {
      expect(markup).toContain(header);
    }
  });

  /**
   * A count off an array the caller fetched with `limit: 12` is not a fleet
   * total. The tile may only claim what it can back up.
   */
  test('the landing screen scopes a page count instead of presenting it as a total', () => {
    const markup = renderToStaticMarkup(
      <Overview
        apps={[]}
        builds={[build]}
        deploys={[deploy]}
        targets={[]}
        buildsHasMore
        deploysHasMore
        onNavigate={() => undefined}
      />,
    );
    expect(markup).not.toContain('Object explorer');
    expect(markup).toContain('aria-label="Serving"');
    expect(markup).toContain('aria-label="Standing state"');
    expect(markup).toContain('aria-label="Activity"');
    expect(markup).toContain('1+');
    expect(markup).toContain('not a fleet total');
  });

  test('a landing screen with a whole ledger loaded claims the whole ledger', () => {
    const markup = renderToStaticMarkup(
      <Overview
        apps={[]}
        builds={[build]}
        deploys={[deploy]}
        targets={[]}
        onNavigate={() => undefined}
      />,
    );
    expect(markup).not.toContain('1+');
    expect(markup).not.toContain('not a fleet total');
  });

  test('offers the next cursor page instead of truncating history', () => {
    const builds = renderToStaticMarkup(
      <BuildLedger
        builds={[build]}
        hasMore
        onLoadMore={() => undefined}
        onNavigate={() => undefined}
      />,
    );
    const deploys = renderToStaticMarkup(
      <DeployLedger
        deploys={[deploy]}
        hasMore
        onLoadMore={() => undefined}
        onNavigate={() => undefined}
      />,
    );
    expect(builds).toContain('Load older Builds');
    expect(deploys).toContain('Load older Deploys');
  });
});

/** Every element in a tree, depth first — the tree as returned, not rendered. */
function* elements(node: ReactNode): Generator<ReactElement> {
  if (Array.isArray(node)) {
    for (const child of node) yield* elements(child as ReactNode);
    return;
  }
  if (!isValidElement(node)) return;
  yield node;
  yield* elements((node.props as { children?: ReactNode }).children);
}

/** The `rowSearch` a ledger hands its explorer, read off the tree it returns. */
function rowSearchOf<T>(tree: ReactNode): (row: T) => string {
  for (const element of elements(tree)) {
    const { rowSearch } = element.props as { rowSearch?: (row: T) => string };
    if (rowSearch) return rowSearch;
  }
  throw new Error('the ledger rendered no explorer');
}

/**
 * A filter matches the words a row shows. The explorer never reads rendered
 * cells — `rowSearch` is its whole haystack — so a headline printed beside the
 * sha has to be in that string too, or the one thing on the screen an operator
 * would type is the one thing typing cannot find.
 */
describe('a ledger filter matches the headline it shows', () => {
  const HEADLINE = 'feat(web): stop the header wrapping';
  const commit = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

  test('Builds, Deploys and Sources hand the headline to their explorer', () => {
    const build: BuildListItem = {
      id: 1837,
      appId: 'app-morrow',
      app: 'morrow',
      componentId: 'component-web',
      component: 'web',
      commit,
      commitMessage: HEADLINE,
      commitAuthor: 'octocat',
      targetShape: 'image',
      artifactType: 'image',
      artifactDigest: null,
      status: 'PENDING',
      runner: null,
      when: 'now',
      at: '2026-08-03T12:31:00.000Z',
      deployId: null,
      dispatchWaitingOn: null,
    };
    const deploy: DeployLedgerItem = {
      id: 993,
      appId: build.appId,
      app: build.app,
      buildId: build.id,
      componentId: build.componentId,
      component: build.component,
      targetId: 'target-folly',
      target: 'Folly',
      phase: 'LIVE',
      commit,
      commitMessage: HEADLINE,
      configVersion: null,
      when: 'now',
      at: '2026-08-03T12:44:00.000Z',
      current: true,
      rollbackable: false,
    };
    const source: SourceListItem = {
      digest: `sha256:${'a'.repeat(64)}`,
      origin: 'repo',
      repository: 'jonpulsifer/morrow',
      commit,
      commitMessage: HEADLINE,
      commitAuthor: 'octocat',
      commitAuthoredAt: '2026-07-27T09:30:00.000Z',
      location: `gs://bucket/ephemeral/${'a'.repeat(64)}.tgz`,
      fetchable: true,
      retention: 'ephemeral',
      app: build.app,
      component: build.component,
      builds: 1,
      latestBuildId: build.id,
      supplied: false,
      at: '2026-08-03T12:31:00.000Z',
    };
    const noop = () => undefined;

    expect(
      rowSearchOf<BuildListItem>(
        BuildLedger({ builds: [build], onNavigate: noop }),
      )(build),
    ).toContain(HEADLINE);
    expect(
      rowSearchOf<DeployLedgerItem>(
        DeployLedger({ deploys: [deploy], onNavigate: noop }),
      )(deploy),
    ).toContain(HEADLINE);
    expect(
      rowSearchOf<SourceListItem>(
        SourceLedger({ sources: [source], limit: 50, onNavigate: noop }),
      )(source),
    ).toContain(HEADLINE);
  });

  test('the App list keeps the row whose headline is typed', () => {
    const app: AppListItem = {
      id: '00000000-0000-4000-8000-0000000000a1',
      name: 'morrow',
      phase: 'LIVE',
      target: 'Folly',
      vessel: 'driftwood',
      url: 'morrow.apps.example',
      urlLive: true,
      kind: 'service',
      source: 'jonpulsifer/morrow',
      artifact: 'image · a1b2c3d4e5f6',
      commit,
      commitMessage: HEADLINE,
    };
    const deletion: AppDeletionControls = {
      state: { kind: 'idle' } as AppDeletion,
      review: () => undefined,
      confirm: () => undefined,
      dismiss: () => undefined,
    };
    const markup = renderToStaticMarkup(
      <AppList
        apps={[app]}
        filter="header wrapping"
        deletion={deletion}
        onNavigate={() => undefined}
      />,
    );
    expect(markup).not.toContain('No App matches');
    expect(markup).toContain('morrow');
  });
});
