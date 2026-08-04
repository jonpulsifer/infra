import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ObjectExplorer } from '../../src/web/components/object-explorer.tsx';
import { AppShell } from '../../src/web/components/shell.tsx';
import type { BuildListItem, DeployLedgerItem } from '../../src/web/model.ts';
import { BuildLedger } from '../../src/web/views/operations/builds.tsx';
import { DeployLedger } from '../../src/web/views/operations/deploys.tsx';
import { SettingsLayout } from '../../src/web/views/settings/layout.tsx';

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
      'Artifact policy',
      'Notifications',
      'Danger zone',
    ]) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain('real connector controls');
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
    expect(markup).toContain('Artifact ledger');
    expect(markup).toContain('Cloud Build');
    expect(markup).toContain('sha256:abc');
    expect(markup).toContain('Loading Build evidence');
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
