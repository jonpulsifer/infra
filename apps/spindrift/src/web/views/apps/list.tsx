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
import { Ref } from '../../ui/copy.tsx';
import { Page } from '../../ui/page.tsx';
import { Timestamp } from '../../ui/timestamp.tsx';

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

/**
 * What the row says under the name, beyond the phase badge beside it.
 *
 * The row used to read `service · kubernetes` and stop, while the App's shape,
 * its commit and its age were all on the wire — shoved into `search`, where a
 * filter could match them and nobody could read them. The scan this list exists
 * to be is "which of these needs me", and the fact that answers it on a
 * multi-Component App is how much of it is down, not that something is.
 *
 * The count is stated only where there is more than one Component, because "1
 * component" on every row of a fleet of single-service Apps is a column of
 * noise that pushes the fact off the end of the line.
 */
function rowDetail(app: AppListItem): string {
  const parts: string[] = [app.kind, app.target];
  const count = app.componentCount ?? 0;
  if (count > 1) {
    parts.push(
      app.failing
        ? `${app.failing} of ${count} failing`
        : `${count} components`,
    );
  }
  if (app.commit) parts.push(app.commit.slice(0, 7));
  return parts.join(' · ');
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
    detail: rowDetail(app),
    status: app.phase.toLowerCase(),
    tone: phaseTone(app.phase),
    // `ExplorerItem` has carried these two since it was written and this list
    // has never set them, so the one column an operator triages by — how long
    // it has been in the state it is in — was blank on every row.
    ...(app.when === undefined ? {} : { when: app.when }),
    ...(app.at === undefined ? {} : { at: app.at }),
    search: `${app.source} ${app.url} ${app.vessel} ${app.artifact} ${app.commit ?? ''}`,
    active:
      app.phase === 'PENDING' ||
      app.phase === 'APPLYING' ||
      app.phase === 'WAITING',
  }));

  return (
    <Page width="wide">
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
                {app.source} is placed on {app.target}, a surface on{' '}
                <span className="font-mono">{app.vessel}</span>.
                {app.componentCount && app.componentCount > 1 ? (
                  <>
                    {' '}
                    The state above is the worst of its {app.componentCount}{' '}
                    Components.
                  </>
                ) : null}
              </p>
              <DefinitionGrid
                entries={[
                  { label: 'State', value: app.phase.toLowerCase() },
                  { label: 'Target', value: app.target },
                  { label: 'Artifact', value: app.artifact, mono: true },
                  // The commit and the instant were both loaded and neither was
                  // rendered anywhere on this screen, so "what is running" was
                  // answerable only by opening the App and then its release.
                  ...(app.commit
                    ? [
                        {
                          label: 'Commit',
                          value: <Ref value={app.commit} kind="commit" />,
                          title: app.commit,
                        },
                      ]
                    : []),
                  ...(app.at
                    ? [
                        {
                          label: 'Released',
                          value: <Timestamp at={app.at} when={app.when} />,
                          title: app.at,
                        },
                      ]
                    : []),
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
                {/*
                  First, and it stays first: `app-list-identity.test.tsx` walks
                  this inspector for the first control carrying an `onClick` and
                  presses it, because the claim under test is that a row reaches
                  *its own* App and not the other one wearing the same name.
                */}
                <Button onClick={() => onNavigate(`/apps/${app.id}`)}>
                  Open App
                </Button>
                {app.deployId === undefined ? null : (
                  <Button
                    variant="outline"
                    onClick={() => onNavigate(`/deploys/${app.deployId}`)}
                  >
                    Open release
                  </Button>
                )}
                {href !== null ? (
                  <Button variant="outline" asChild>
                    {/* The icon has always promised a new tab. Now it keeps
                        the promise, and without handing over the referrer. */}
                    <a href={href} target="_blank" rel="noreferrer noopener">
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
    </Page>
  );
}
