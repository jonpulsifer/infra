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
import type { BuildListItem, BuildStatus } from '../../model.ts';
import { Badge } from '../../ui/badge.tsx';
import { Button } from '../../ui/button.tsx';
import { Eyebrow } from '../../ui/card.tsx';

function tone(status: BuildStatus): ExplorerTone {
  if (status === 'SUCCEEDED') return 'success';
  if (status === 'FAILED') return 'destructive';
  return 'accent';
}

export function BuildLedger({
  builds,
  onNavigate,
  hasMore = false,
  loadingMore = false,
  loadError = null,
  onLoadMore,
}: {
  readonly builds: readonly BuildListItem[];
  readonly onNavigate: (path: string) => void;
  readonly hasMore?: boolean;
  readonly loadingMore?: boolean;
  readonly loadError?: string | null;
  readonly onLoadMore?: () => void;
}) {
  const byId = new Map(builds.map((build) => [`build:${build.id}`, build]));
  const items: ExplorerItem[] = builds.map((build) => ({
    id: `build:${build.id}`,
    title: `#${build.id} · ${build.app}`,
    detail: `${build.component} · ${build.commit.slice(0, 12)}`,
    status: build.status.toLowerCase(),
    tone: tone(build.status),
    when: build.when,
    at: build.at,
    search: `${build.runner ?? ''} ${build.targetShape} ${build.artifactType}`,
    active: build.status === 'PENDING' || build.status === 'RUNNING',
  }));

  return (
    <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <ExplorerPageHeader
        eyebrow="Artifact ledger"
        title="Builds"
        description="Source becomes an artifact here. Placement remains a separate Deploy, with its own state and evidence."
      />
      <ObjectExplorer
        items={items}
        filterPlaceholder={`Filter ${builds.length} Builds…`}
        empty={
          <div className="rounded-sm border border-border bg-card p-10 text-center text-sm text-muted-foreground">
            No Builds exist yet. Creating and deploying an App starts the first
            one.
          </div>
        }
        renderInspector={(item) => {
          const build = byId.get(item.id)!;
          return (
            <>
              <Eyebrow>Build / {build.id}</Eyebrow>
              <div className="mt-1 flex flex-wrap items-center gap-3">
                <h2 className="text-2xl font-semibold tracking-tight">
                  {build.app} / {build.component}
                </h2>
                <Badge tone={tone(build.status)}>
                  {build.status.toLowerCase()}
                </Badge>
              </div>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                Turning commit <span className="font-mono">{build.commit}</span>{' '}
                into a {build.artifactType} artifact for {build.targetShape}.
              </p>
              <DefinitionGrid
                entries={[
                  { label: 'State', value: build.status.toLowerCase() },
                  { label: 'Created', value: build.when, mono: true },
                  {
                    label: 'Runner',
                    value: build.runner ?? 'supplied artifact',
                  },
                  {
                    label: 'Artifact',
                    value: build.artifactDigest?.slice(0, 20) ?? 'not produced',
                    mono: true,
                  },
                  { label: 'Shape', value: build.targetShape, mono: true },
                  {
                    label: 'Commit',
                    value: build.commit.slice(0, 12),
                    mono: true,
                  },
                ]}
              />
              <BuildEvidence buildId={build.id} />
              <div className="mt-6 flex flex-wrap gap-2">
                <Button onClick={() => onNavigate(`/builds/${build.id}`)}>
                  Open Build
                </Button>
                {build.deployId !== null ? (
                  <Button
                    variant="outline"
                    onClick={() => onNavigate(`/deploys/${build.deployId}`)}
                  >
                    Related Deploy
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  onClick={() => onNavigate(`/apps/${build.appId}`)}
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
            {loadingMore ? 'Loading older Builds…' : 'Load older Builds'}
          </Button>
        </div>
      ) : builds.length > 0 ? (
        <p className="text-center text-xs text-muted-foreground">
          Entire Build ledger loaded.
        </p>
      ) : null}
    </div>
  );
}

/** Real step evidence for the selected Build, loaded only for its inspector. */
function BuildEvidence({ buildId }: { readonly buildId: number }) {
  const [state, setState] = useState<
    | { type: 'loading' }
    | { type: 'error'; message: string }
    | { type: 'success'; detail: OutputOf<'getBuildDetail'> }
  >({ type: 'loading' });

  useEffect(() => {
    let live = true;
    command('getBuildDetail', { id: buildId })
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
  }, [buildId]);

  return (
    <section className="mt-6 border-t border-border pt-5">
      <Eyebrow>Observed steps</Eyebrow>
      {state.type === 'loading' ? (
        <p className="mt-2 animate-pulse text-sm text-muted-foreground">
          Loading Build evidence…
        </p>
      ) : state.type === 'error' ? (
        <p className="mt-2 text-sm text-destructive">{state.message}</p>
      ) : state.detail.attempt.build === null ? (
        <p className="mt-2 text-sm text-muted-foreground">
          This was a supplied artifact; no builder ran.
        </p>
      ) : (
        <div className="mt-2">
          <Checklist items={state.detail.attempt.build.steps} />
        </div>
      )}
    </section>
  );
}
