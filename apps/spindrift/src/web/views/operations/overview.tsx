import {
  DefinitionGrid,
  type ExplorerItem,
  ExplorerPageHeader,
  type ExplorerTone,
  ObjectExplorer,
} from '../../components/object-explorer.tsx';
import type {
  AppListItem,
  BuildListItem,
  DeployLedgerItem,
  TargetListItem,
} from '../../model.ts';
import { Badge } from '../../ui/badge.tsx';
import { Button } from '../../ui/button.tsx';
import { Eyebrow } from '../../ui/card.tsx';

interface Concern extends ExplorerItem {
  readonly eyebrow: string;
  readonly summary: string;
  readonly path: string;
  readonly appPath?: string;
  readonly facts: readonly {
    readonly label: string;
    readonly value: string;
    readonly mono?: boolean;
  }[];
}

function buildTone(status: BuildListItem['status']): ExplorerTone {
  if (status === 'FAILED') return 'destructive';
  if (status === 'SUCCEEDED') return 'success';
  return 'accent';
}

function deployTone(phase: DeployLedgerItem['phase']): ExplorerTone {
  if (phase === 'FAILED') return 'destructive';
  if (phase === 'LIVE') return 'success';
  return 'accent';
}

function appTone(phase: AppListItem['phase']): ExplorerTone {
  if (phase === 'FAILED') return 'destructive';
  if (phase === 'LIVE') return 'success';
  return 'warning';
}

export function Overview({
  apps,
  builds,
  deploys,
  targets,
  onNavigate,
}: {
  readonly apps: readonly AppListItem[];
  readonly builds: readonly BuildListItem[];
  readonly deploys: readonly DeployLedgerItem[];
  readonly targets: readonly TargetListItem[];
  readonly onNavigate: (path: string) => void;
}) {
  const concerns: Concern[] = [
    ...deploys
      .filter((deploy) => deploy.phase !== 'LIVE')
      .map(
        (deploy): Concern => ({
          id: `deploy:${deploy.id}`,
          title: `Deploy ${deploy.id}`,
          detail: `${deploy.app} / ${deploy.component} · ${deploy.target}`,
          status: deploy.phase.toLowerCase(),
          tone: deployTone(deploy.phase),
          when: deploy.when,
          at: deploy.at,
          active: deploy.phase !== 'FAILED',
          eyebrow: `Deploy / ${deploy.id}`,
          summary: `Build ${deploy.buildId} is being placed on ${deploy.target}.`,
          path: `/deploys/${deploy.id}`,
          appPath: `/apps/${deploy.appId}`,
          search: `${deploy.commit} ${deploy.app}`,
          facts: [
            { label: 'Build', value: String(deploy.buildId), mono: true },
            { label: 'Target', value: deploy.target },
            { label: 'Started', value: deploy.when, mono: true },
          ],
        }),
      ),
    ...builds
      .filter((build) => build.status !== 'SUCCEEDED')
      .map(
        (build): Concern => ({
          id: `build:${build.id}`,
          title: `Build ${build.id}`,
          detail: `${build.app} / ${build.component} · ${build.runner ?? 'queued'}`,
          status: build.status.toLowerCase(),
          tone: buildTone(build.status),
          when: build.when,
          at: build.at,
          active: build.status !== 'FAILED',
          eyebrow: `Build / ${build.id}`,
          summary: `Commit ${build.commit} is becoming a ${build.artifactType} artifact.`,
          path: `/builds/${build.id}`,
          appPath: `/apps/${build.appId}`,
          search: `${build.commit} ${build.app}`,
          facts: [
            { label: 'Runner', value: build.runner ?? 'waiting' },
            { label: 'Shape', value: build.targetShape, mono: true },
            { label: 'Created', value: build.when, mono: true },
          ],
        }),
      ),
    ...targets
      .filter(
        (target) =>
          !target.configured ||
          target.status === 'disconnected' ||
          target.health === 'unhealthy',
      )
      .map(
        (target): Concern => ({
          id: `target:${target.id}`,
          title: target.name,
          detail: `${target.adapter} Target · prerequisite attention`,
          status: target.configured ? target.health : 'setup',
          tone: 'warning',
          eyebrow: 'Target concern',
          summary:
            target.prerequisiteFailures?.[0] ??
            'This Target still needs its connection completed.',
          path: '/settings/connections',
          search: `${target.adapter} ${target.prerequisiteFailures?.join(' ') ?? ''}`,
          facts: [
            { label: 'Adapter', value: target.adapter },
            { label: 'Connection', value: target.status },
            { label: 'Rank', value: String(target.rank), mono: true },
          ],
        }),
      ),
    ...apps.slice(0, 6).map(
      (app): Concern => ({
        id: `app:${app.id}`,
        title: app.name,
        detail: `${app.kind} · ${app.target}`,
        status: app.phase.toLowerCase(),
        tone: appTone(app.phase),
        active: app.phase !== 'LIVE' && app.phase !== 'FAILED',
        eyebrow: `App / ${app.kind}`,
        summary: `${app.source} · ${app.url || 'no URL yet'}`,
        path: `/apps/${app.id}`,
        search: `${app.source} ${app.url}`,
        facts: [
          { label: 'Target', value: app.target },
          { label: 'Artifact', value: app.artifact, mono: true },
          { label: 'URL', value: app.url || 'not allocated', mono: true },
        ],
      }),
    ),
  ].slice(0, 18);
  const byId = new Map(concerns.map((concern) => [concern.id, concern]));

  return (
    <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <ExplorerPageHeader
        eyebrow="Operating view"
        title="Object explorer"
        description="Scan active work and current contracts, then inspect one object without losing your place."
        actions={
          <Button onClick={() => onNavigate('/apps/new')}>Create App</Button>
        }
      />
      <ObjectExplorer
        items={concerns}
        filterPlaceholder="Filter active objects…"
        empty={
          <div className="rounded-sm border border-success/40 bg-card p-10 text-center">
            <p className="font-semibold text-success">Everything is steady.</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Create an App to put the first object in motion.
            </p>
          </div>
        }
        renderInspector={(item) => {
          const concern = byId.get(item.id)!;
          return (
            <>
              <Eyebrow>{concern.eyebrow}</Eyebrow>
              <div className="mt-1 flex flex-wrap items-center gap-3">
                <h2 className="text-2xl font-semibold tracking-tight">
                  {concern.title}
                </h2>
                <Badge tone={concern.tone}>{concern.status}</Badge>
              </div>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                {concern.summary}
              </p>
              <DefinitionGrid entries={concern.facts} />
              <div className="mt-6 flex flex-wrap gap-2">
                <Button onClick={() => onNavigate(concern.path)}>
                  Open {concern.eyebrow.split(' / ')[0]}
                </Button>
                {concern.appPath ? (
                  <Button
                    variant="outline"
                    onClick={() => onNavigate(concern.appPath!)}
                  >
                    Open App
                  </Button>
                ) : null}
              </div>
            </>
          );
        }}
      />
    </div>
  );
}
