/**
 * PROTOTYPE mount — the real App workspace, three shapes of "build from new
 * bytes", no database.
 *
 * `WORKSPACE_SCENARIOS` is the fixture the view tests already build, so this is
 * the production `Workspace` with production density rather than a mock of it.
 * `?variant=A|B|C` selects, `?scenario=` picks the fixture, and the bar at the
 * bottom flips both. Throwaway — delete with `views/apps/prototype-new-build.tsx`.
 */
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  TARGET_LIST,
  WORKSPACE_SCENARIOS,
} from '../../../test/fixtures/scenarios.ts';
import { restoreTheme } from '../theme.ts';
import type {
  PrototypeVariant,
  StagedUpload,
} from '../views/apps/prototype-new-build.tsx';
import { PrototypeSwitcher } from '../views/apps/prototype-new-build.tsx';
import { Workspace, type WorkspaceTab } from '../views/apps/workspace.tsx';

type ScenarioName = keyof typeof WORKSPACE_SCENARIOS;

function paramOf(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

function put(name: string, value: string) {
  const url = new URL(window.location.href);
  url.searchParams.set(name, value);
  window.history.replaceState(null, '', url);
}

/** The real endpoint. The prototype server answers it with a true-shaped row. */
async function stage(file: File): Promise<StagedUpload> {
  const response = await fetch('/internal/upload', {
    method: 'POST',
    headers: { 'x-filename': file.name },
    body: file,
  });
  const body = (await response.json()) as
    | { ok: true; value: StagedUpload }
    | { ok: false; failure: { message: string } };
  if (!body.ok) throw new Error(body.failure.message);
  return body.value;
}

function Prototype() {
  const [variant, setVariant] = useState<PrototypeVariant>(
    (paramOf('variant') as PrototypeVariant | null) ?? 'A',
  );
  const [scenario, setScenario] = useState<ScenarioName>(
    (paramOf('scenario') as ScenarioName | null) ?? 'website',
  );
  const [archiveSourced, setArchiveSourced] = useState(
    paramOf('source') !== 'repo',
  );
  const [tab, setTab] = useState<WorkspaceTab>(
    (paramOf('tab') as WorkspaceTab | null) ?? 'overview',
  );

  const view = WORKSPACE_SCENARIOS[scenario];

  return (
    <div className="min-h-screen bg-background pb-24 text-foreground">
      <div className="border-warning border-b-2 bg-warning/10 px-6 py-1.5 text-center font-mono text-warning text-xs uppercase tracking-widest">
        Prototype · not shipped ·{' '}
        <button
          type="button"
          className="underline"
          onClick={() => {
            const names = Object.keys(WORKSPACE_SCENARIOS) as ScenarioName[];
            const at = names.indexOf(scenario);
            const next = names[(at + 1) % names.length];
            if (next) {
              setScenario(next);
              put('scenario', next);
            }
          }}
        >
          scenario: {scenario}
        </button>{' '}
        ·{' '}
        <button
          type="button"
          className="underline"
          onClick={() => {
            const next =
              tab === 'overview'
                ? 'releases'
                : tab === 'releases'
                  ? 'config'
                  : 'overview';
            setTab(next);
            put('tab', next);
          }}
        >
          tab: {tab}
        </button>
      </div>

      <Workspace
        view={view}
        tab={tab}
        targets={TARGET_LIST}
        onDeploy={() => {}}
        onRebuild={() => {}}
        onSelectComponent={() => {}}
        onSetReach={async () => ({ ok: true, pendingRelease: [] })}
        prototype={{
          variant,
          archiveSourced,
          onStage: stage,
        }}
      />

      <PrototypeSwitcher
        current={variant}
        archiveSourced={archiveSourced}
        onToggleSource={() => {
          setArchiveSourced((was) => {
            put('source', was ? 'repo' : 'archive');
            return !was;
          });
        }}
        onSelect={(next) => {
          setVariant(next);
          put('variant', next);
        }}
      />
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('no #root element to mount on');
restoreTheme();
createRoot(root).render(
  <StrictMode>
    <Prototype />
  </StrictMode>,
);
