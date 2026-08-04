/**
 * The App list (§18).
 *
 * **The scan of what exists** — name, phase, placement, URL — is the entry
 * surface. Clicking a row navigates to the workspace; the list itself never
 * renders pipeline detail. The one action is **New App**, which is the same
 * front-page tile the creation flow opens with.
 *
 * An empty list is its own onboarding: the first thing a fresh install sees is
 * the New App action, not a dashboard with empty charts.
 *
 * The one exception to "the one action is New App" is the trash affordance on
 * each row. It is here rather than only in the workspace because the App this
 * list most often has too many of is the one nothing was ever deployed from, and
 * making the operator open a workspace to throw one away is what leaves a fresh
 * install's failed first attempts on the screen forever. What it opens is a
 * review, not a delete — `components/delete-app.tsx` owns that whole flow.
 *
 * **A row stands for an App, not for a name.** `apps` has no unique constraint
 * on `name`, so the key, the link, and the delete all go by `AppListItem.id`.
 * By name, two Apps called the same thing share one React key, one workspace,
 * and one refused delete — which leaves the second one persisted and with no
 * route to it at all.
 */
import { ExternalLink, Globe, Plus, Server, Zap } from 'lucide-react';
import {
  type AppDeletionControls,
  DeleteAppButton,
} from '../../components/delete-app.tsx';
import {
  DefinitionGrid,
  type ExplorerItem,
  ExplorerPageHeader,
  ObjectExplorer,
} from '../../components/object-explorer.tsx';
import type { AppListItem, DeployPhase } from '../../model.ts';
import { Badge } from '../../ui/badge.tsx';
import { Button } from '../../ui/button.tsx';
import { Eyebrow } from '../../ui/card.tsx';

function kindIcon(kind: string) {
  switch (kind) {
    case 'website':
      return (
        <Globe aria-hidden="true" className="size-4 text-muted-foreground" />
      );
    case 'job':
      return (
        <Zap aria-hidden="true" className="size-4 text-muted-foreground" />
      );
    default:
      return (
        <Server aria-hidden="true" className="size-4 text-muted-foreground" />
      );
  }
}

function phaseTone(
  phase: DeployPhase,
): 'success' | 'warning' | 'destructive' | 'idle' {
  switch (phase) {
    case 'LIVE':
      return 'success';
    case 'FAILED':
      return 'destructive';
    case 'PENDING':
    case 'APPLYING':
    case 'WAITING':
      return 'warning';
    default:
      return 'idle';
  }
}

/** A stored App address may be either a hostname or an absolute HTTP URL. */
export function appHref(url: string): string | null {
  const value = url.trim();
  if (value === '') return null;
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

export function AppList({
  apps,
  onNavigate,
  deletion,
}: {
  apps: readonly AppListItem[];
  onNavigate: (path: string) => void;
  deletion: AppDeletionControls;
}) {
  const byId = new Map(apps.map((app) => [`app:${app.id}`, app]));
  const items: ExplorerItem[] = apps.map((app) => ({
    id: `app:${app.id}`,
    title: app.name,
    detail: `${app.kind} · ${app.target}`,
    status: app.phase.toLowerCase(),
    tone: phaseTone(app.phase),
    search: `${app.source} ${app.url} ${app.vessel} ${app.artifact}`,
    active:
      app.phase === 'PENDING' ||
      app.phase === 'APPLYING' ||
      app.phase === 'WAITING',
  }));

  return (
    <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <ExplorerPageHeader
        eyebrow="Application catalog"
        title="Apps"
        description="Inspect each App's current contract, placement, source, and artifact without leaving the catalog."
        actions={
          <Button onClick={() => onNavigate('/apps/new')}>
            <Plus aria-hidden="true" className="size-4" /> New App
          </Button>
        }
      />
      <ObjectExplorer
        items={items}
        filterPlaceholder={`Filter ${apps.length} Apps…`}
        empty={
          <div className="rounded-sm border border-border bg-card px-6 py-12 text-center">
            <p className="text-sm text-muted-foreground">
              No Apps yet. Create one to establish its first deployment
              contract.
            </p>
            <Button className="mt-4" onClick={() => onNavigate('/apps/new')}>
              <Plus aria-hidden="true" className="size-4" /> Create App
            </Button>
          </div>
        }
        renderInspector={(item) => {
          const app = byId.get(item.id)!;
          const href = app.urlLive ? appHref(app.url) : null;
          return (
            <>
              <Eyebrow>App / {app.kind}</Eyebrow>
              <div className="mt-1 flex flex-wrap items-center gap-3">
                {kindIcon(app.kind)}
                <h2 className="text-2xl font-semibold tracking-tight">
                  {app.name}
                </h2>
                <Badge tone={phaseTone(app.phase)}>
                  {app.phase.toLowerCase()}
                </Badge>
              </div>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                {app.source} is placed on {app.target} in the immutable vessel{' '}
                <span className="font-mono">{app.vessel}</span>.
              </p>
              <DefinitionGrid
                entries={[
                  { label: 'State', value: app.phase.toLowerCase() },
                  { label: 'Target', value: app.target },
                  { label: 'Artifact', value: app.artifact, mono: true },
                  { label: 'Source', value: app.source, mono: true },
                  { label: 'Vessel', value: app.vessel, mono: true },
                  {
                    label: 'URL',
                    value: app.url || 'not allocated',
                    mono: true,
                  },
                ]}
              />
              <div className="mt-6 flex flex-wrap gap-2">
                <Button onClick={() => onNavigate(`/apps/${app.id}`)}>
                  Open App
                </Button>
                {href !== null ? (
                  <Button variant="outline" asChild>
                    <a href={href}>
                      Open URL <ExternalLink aria-hidden="true" />
                    </a>
                  </Button>
                ) : null}
                <DeleteAppButton
                  appId={app.id}
                  name={app.name}
                  deletion={deletion}
                  label
                />
              </div>
            </>
          );
        }}
      />
    </div>
  );
}
