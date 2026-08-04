import { useEffect, useState } from 'react';
import { command, type OutputOf } from '../../client.ts';
import { Checklist } from '../../components/checklist.tsx';
import {
  DefinitionGrid,
  type ExplorerItem,
  ExplorerPageHeader,
  type ExplorerTone,
  ObjectExplorer,
} from '../../components/object-explorer.tsx';
import type { DeployLedgerItem, DeployPhase } from '../../model.ts';
import { Badge } from '../../ui/badge.tsx';
import { Button } from '../../ui/button.tsx';
import { Eyebrow } from '../../ui/card.tsx';

function tone(phase: DeployPhase): ExplorerTone {
  if (phase === 'LIVE') return 'success';
  if (phase === 'FAILED') return 'destructive';
  return 'accent';
}

export function DeployLedger({
  deploys,
  onNavigate,
  hasMore = false,
  loadingMore = false,
  loadError = null,
  onLoadMore,
}: {
  readonly deploys: readonly DeployLedgerItem[];
  readonly onNavigate: (path: string) => void;
  readonly hasMore?: boolean;
  readonly loadingMore?: boolean;
  readonly loadError?: string | null;
  readonly onLoadMore?: () => void;
}) {
  const byId = new Map(
    deploys.map((deploy) => [`deploy:${deploy.id}`, deploy]),
  );
  const items: ExplorerItem[] = deploys.map((deploy) => ({
    id: `deploy:${deploy.id}`,
    title: `#${deploy.id} · ${deploy.app}`,
    detail: `${deploy.component} · ${deploy.target} · Build ${deploy.buildId}`,
    status: deploy.phase.toLowerCase(),
    tone: tone(deploy.phase),
    when: deploy.when,
    at: deploy.at,
    search: `${deploy.commit} ${deploy.configVersion ?? ''}`,
    active:
      deploy.phase === 'PENDING' ||
      deploy.phase === 'APPLYING' ||
      deploy.phase === 'WAITING',
  }));

  return (
    <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <ExplorerPageHeader
        eyebrow="Placement ledger"
        title="Deploys"
        description="Verified artifacts are placed and observed here. Build failures stay in Builds; runtime and rollout evidence stays with the Deploy."
      />
      <ObjectExplorer
        items={items}
        filterPlaceholder={`Filter ${deploys.length} Deploys…`}
        empty={
          <div className="rounded-sm border border-border bg-card p-10 text-center text-sm text-muted-foreground">
            No Deploys exist yet. A successful Build becomes placeable here.
          </div>
        }
        renderInspector={(item) => {
          const deploy = byId.get(item.id)!;
          return (
            <>
              <Eyebrow>Deploy / {deploy.id}</Eyebrow>
              <div className="mt-1 flex flex-wrap items-center gap-3">
                <h2 className="text-2xl font-semibold tracking-tight">
                  {deploy.app} / {deploy.component}
                </h2>
                <Badge tone={tone(deploy.phase)}>
                  {deploy.phase.toLowerCase()}
                </Badge>
              </div>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                Placing Build {deploy.buildId} on {deploy.target}. This attempt
                pins commit <span className="font-mono">{deploy.commit}</span>.
              </p>
              <DefinitionGrid
                entries={[
                  { label: 'State', value: deploy.phase.toLowerCase() },
                  { label: 'Build', value: deploy.buildId, mono: true },
                  { label: 'Target', value: deploy.target },
                  { label: 'Started', value: deploy.when, mono: true },
                  {
                    label: 'Config',
                    value: deploy.configVersion?.slice(0, 12) ?? 'none',
                    mono: true,
                  },
                  { label: 'Current', value: deploy.current ? 'yes' : 'no' },
                ]}
              />
              <DeployEvidence deployId={deploy.id} />
              <div className="mt-6 flex flex-wrap gap-2">
                <Button onClick={() => onNavigate(`/deploys/${deploy.id}`)}>
                  Open Deploy
                </Button>
                <Button
                  variant="outline"
                  onClick={() => onNavigate(`/apps/${deploy.appId}`)}
                >
                  Open App
                </Button>
              </div>
            </>
          );
        }}
      />
      {loadError ? (
        <p className="text-sm text-destructive">{loadError}</p>
      ) : null}
      {hasMore ? (
        <div className="flex justify-center">
          <Button variant="outline" disabled={loadingMore} onClick={onLoadMore}>
            {loadingMore ? 'Loading older Deploys…' : 'Load older Deploys'}
          </Button>
        </div>
      ) : deploys.length > 0 ? (
        <p className="text-center text-xs text-muted-foreground">
          Entire Deploy ledger loaded.
        </p>
      ) : null}
    </div>
  );
}

/** Real Build and placement evidence for the selected Deploy inspector. */
function DeployEvidence({ deployId }: { readonly deployId: number }) {
  const [state, setState] = useState<
    | { type: 'loading' }
    | { type: 'error'; message: string }
    | { type: 'success'; detail: OutputOf<'getDeployDetail'> }
  >({ type: 'loading' });

  useEffect(() => {
    let live = true;
    command('getDeployDetail', { id: deployId })
      .then((result) => {
        if (!live) return;
        setState(
          result.ok
            ? { type: 'success', detail: result.value }
            : { type: 'error', message: result.failure.message },
        );
      })
      .catch((cause: unknown) => {
        if (live) {
          setState({
            type: 'error',
            message: cause instanceof Error ? cause.message : 'Evidence failed',
          });
        }
      });
    return () => {
      live = false;
    };
  }, [deployId]);

  return (
    <section className="mt-6 border-t border-border pt-5">
      <Eyebrow>Observed evidence</Eyebrow>
      {state.type === 'loading' ? (
        <p className="mt-2 animate-pulse text-sm text-muted-foreground">
          Loading Deploy evidence…
        </p>
      ) : state.type === 'error' ? (
        <p className="mt-2 text-sm text-destructive">{state.message}</p>
      ) : (
        <div className="mt-2 grid gap-5 xl:grid-cols-2">
          <div>
            <p className="mb-1 text-xs font-semibold text-muted-foreground">
              Placement
            </p>
            <Checklist items={state.detail.deploy.resources} />
          </div>
          <div>
            <p className="mb-1 text-xs font-semibold text-muted-foreground">
              Artifact production
            </p>
            {state.detail.deploy.build === null ? (
              <p className="py-2 text-sm text-muted-foreground">
                Supplied artifact; no builder ran.
              </p>
            ) : (
              <Checklist items={state.detail.deploy.build.steps} />
            )}
          </div>
        </div>
      )}
    </section>
  );
}
