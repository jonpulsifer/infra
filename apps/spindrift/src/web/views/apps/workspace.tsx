/**
 * The App workspace (Task 40, §18).
 *
 * **Live state and URL lead**, then Target and the immutable vessel, then
 * Components and Datastores as **peer actionable sections**, then a dense
 * activity timeline. The peering is the decision worth protecting: a Datastore
 * is a top-level noun that an App attaches (§11), never a field on the App, and
 * a layout that nests it under Components would quietly say the opposite.
 *
 * Two things are stated here rather than hidden:
 *
 * - **The vessel is immutable** (§14). A developer who does not find the
 *   setting will go looking for it, so the absence is labelled.
 * - **A `website` has no runtime**, one level down (§17, §18). Static files are
 *   served by the Target, so there is no process output — an honest empty state,
 *   not a disabled tab.
 */
import { ChevronRight, ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  type AppDeletionControls,
  DeleteAppButton,
} from '../../components/delete-app.tsx';
import { EmptyState, LogPane } from '../../components/log-pane.tsx';
import { PhasePill } from '../../components/status.tsx';
import type {
  ActivityEntry,
  ComponentView,
  DatastoreView,
  DeployListItem,
  WorkspaceView,
} from '../../model.ts';
import { Badge } from '../../ui/badge.tsx';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardHeader, Eyebrow } from '../../ui/card.tsx';
import { cn } from '../../ui/utils.ts';
import { Releases } from './releases.tsx';

export function Workspace({
  view,
  onDeploy,
  onRebuild,
  deploying = false,
  onNavigate,
  deletion,
  onRollback,
  rollingBack = null,
}: {
  view: WorkspaceView;
  onDeploy?: () => void;
  /**
   * Ask for a Build outright.
   *
   * Its own control rather than a mode on the one above, because that button's
   * whole job is to decide — and a decision an operator can silently flip is
   * the substitution `deployApp` refuses to make. Always offered, never
   * conditional on what is built: "Rebuild" does exactly one thing whatever
   * the state, which is what makes it safe to press next to one that does not.
   */
  onRebuild?: () => void;
  deploying?: boolean;
  onNavigate?: (path: string) => void;
  /**
   * Absent where there is nothing to navigate back to after a delete — the
   * screen owns where the operator lands, so a caller that cannot answer that
   * question does not offer the act.
   */
  deletion?: AppDeletionControls;
  onRollback?: (release: DeployListItem) => void;
  rollingBack?: number | null;
}) {
  const primary = view.components[0];

  return (
    <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-4 px-5 py-6">
      <header className="flex flex-wrap items-end gap-4">
        <div>
          <Eyebrow>
            {primary ? `${primary.kind} · ${primary.name}` : 'app'}
          </Eyebrow>
          <h1 className="text-2xl font-semibold tracking-tight">{view.app}</h1>
        </div>
        <div className="ml-auto flex gap-2">
          {/* And the id, because a name is not one: `deleteApp` resolves on the
              id, and a workspace that only knew what this App is called could
              not tell it apart from another App called the same thing. */}
          {deletion && view.appId ? (
            <DeleteAppButton
              appId={view.appId}
              name={view.app}
              deletion={deletion}
              label
            />
          ) : null}
          <Button variant="outline" asChild>
            <a href={`https://${view.url}`}>
              Open app <ExternalLink aria-hidden="true" />
            </a>
          </Button>
          {onRebuild ? (
            <Button variant="outline" onClick={onRebuild} disabled={deploying}>
              Rebuild
            </Button>
          ) : null}
          <Button onClick={onDeploy} disabled={deploying}>
            {deploying
              ? 'Deploying...'
              : primary?.kind === 'job'
                ? 'Run now'
                : 'Deploy'}
          </Button>
        </div>
      </header>

      <Hero view={view} onNavigate={onNavigate} />

      <div className="grid gap-4 md:grid-cols-2">
        <Components components={view.components} />
        <Datastores datastores={view.datastores} />
      </div>

      <ReleaseHistory
        deploys={view.deploys}
        onNavigate={onNavigate}
        onRollback={onRollback}
        rollingBack={rollingBack}
      />

      <div className="grid gap-4 md:grid-cols-2">
        <Activity entries={view.activity} onNavigate={onNavigate} />
        <Runtime view={view} onNavigate={onNavigate} />
      </div>
    </div>
  );
}

/** Live state and URL on the left; placement on the right. */
function Hero({
  view,
  onNavigate,
}: {
  view: WorkspaceView;
  onNavigate?: (path: string) => void;
}) {
  return (
    <Card className="flex flex-wrap items-start gap-6 px-5 py-5">
      <div className="flex flex-col gap-2">
        <PhasePill phase={view.phase}>{view.phase}</PhasePill>
        <p className="text-xl font-semibold tracking-tight">
          {view.urlLive
            ? 'Your App is live'
            : 'Your App has no release serving yet'}
        </p>
        <a
          href={`https://${view.url}`}
          className={cn(
            'font-mono text-[15px]',
            view.urlLive
              ? 'border-b border-current text-accent-foreground'
              : 'pointer-events-none text-muted-foreground',
          )}
        >
          {view.url}
        </a>
        {/*
          The release is a link because it is a thing, not a label: §2's Deploy
          is Heroku's Release, and the attempt that produced what is running is
          one press away from the screen that says how it went.
        */}
        {view.latestDeployId !== undefined && onNavigate ? (
          <button
            type="button"
            onClick={() => onNavigate(`/deploys/${view.latestDeployId}`)}
            className="self-start text-xs text-subtle hover:text-foreground"
          >
            {view.release} →
          </button>
        ) : (
          <Eyebrow>{view.release}</Eyebrow>
        )}
      </div>

      <div className="ml-auto flex flex-col gap-1 text-right">
        <Eyebrow>Placement</Eyebrow>
        <p className="font-semibold">{view.target}</p>
        <p className="font-mono text-xs text-muted-foreground">
          {view.vessel} · immutable vessel
        </p>
        <p className="text-xs text-muted-foreground">
          {view.prerequisitesMet
            ? 'All prerequisites passing'
            : 'A prerequisite is unmet'}
        </p>
      </div>
    </Card>
  );
}

/**
 * A section's label, and its one action where it has one.
 *
 * `action` is optional because not every section does something: the timeline
 * is read by clicking its own entries, and a "View all" beside it would be a
 * button whose absence of a destination the reader discovers by pressing it.
 */
function SectionHeader({
  eyebrow,
  title,
  action,
  onAction,
}: {
  eyebrow: string;
  title: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <CardHeader>
      <div>
        <Eyebrow>{eyebrow}</Eyebrow>
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
      </div>
      {action ? (
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={onAction}
        >
          {action}
        </Button>
      ) : null}
    </CardHeader>
  );
}

/** One row of a peer section — a badge, two lines, and an affordance. */
function Row({
  badge,
  title,
  detail,
  trailing,
}: {
  badge: ReactNode;
  title: string;
  detail: string;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-border-soft py-2.5 last:border-b-0">
      {badge}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{title}</p>
        <p className="truncate text-xs text-muted-foreground">{detail}</p>
      </div>
      {trailing ?? (
        <ChevronRight
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground"
        />
      )}
    </div>
  );
}

function Components({ components }: { components: readonly ComponentView[] }) {
  return (
    <Card>
      <SectionHeader
        eyebrow="App structure"
        title="Components"
        action="Add Component"
      />
      <CardContent className="pt-0">
        {components.map((component) => (
          <Row
            key={component.name}
            badge={<Badge tone="accent">{component.kind}</Badge>}
            title={component.name}
            detail={`${component.phase} · ${component.exposure} · ${component.artifact}`}
          />
        ))}
      </CardContent>
    </Card>
  );
}

/**
 * §11: Datastores are top-level and attached, never a field. An unattached one
 * is still listed — it exists whether or not this App uses it, and attaching it
 * is an act with placement consequences (§3), not a toggle.
 */
function Datastores({ datastores }: { datastores: readonly DatastoreView[] }) {
  return (
    <Card>
      <SectionHeader
        eyebrow="Attached resources"
        title="Datastores"
        action="Attach Datastore"
      />
      <CardContent className="pt-0">
        {datastores.length === 0 ? (
          <EmptyState title="No Datastores attached.">
            Attach an existing Postgres or Redis Datastore, or create a managed
            one. A website cannot attach one.
          </EmptyState>
        ) : (
          datastores.map((datastore) => (
            <Row
              key={datastore.name}
              badge={
                <Badge tone={datastore.attachedTo ? 'success' : 'idle'}>
                  {datastore.engine}
                </Badge>
              }
              title={datastore.name}
              detail={
                datastore.attachedTo
                  ? `${datastore.provenance} · ${datastore.target} · attached to ${datastore.attachedTo}`
                  : `${datastore.provenance} · ${datastore.target} · unattached`
              }
              trailing={
                datastore.attachedTo ? undefined : (
                  <Button variant="outline" size="sm">
                    Attach
                  </Button>
                )
              }
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Every release of this App, newest first (§2).
 *
 * A full-width section rather than a card in the two-column grid: it is the
 * history of the thing the whole screen is about, and §2's "one Build → many
 * Deploys" is only legible when the many are listed.
 */
function ReleaseHistory({
  deploys,
  onNavigate,
  onRollback,
  rollingBack,
}: {
  deploys: readonly DeployListItem[];
  onNavigate?: (path: string) => void;
  onRollback?: (release: DeployListItem) => void;
  rollingBack: number | null;
}) {
  return (
    <Card>
      <CardHeader>
        <div>
          <Eyebrow>Deploy history</Eyebrow>
          <h2 className="text-base font-semibold tracking-tight">Releases</h2>
        </div>
        <p className="ml-auto max-w-[46ch] text-right text-xs text-muted-foreground">
          Each release is immutable — its Build, its commit, and the
          configuration it pinned. Rolling back deploys an older one; it never
          rebuilds.
        </p>
      </CardHeader>
      <CardContent className="pt-0">
        <Releases
          deploys={deploys}
          onNavigate={onNavigate}
          onRollback={onRollback}
          rollingBack={rollingBack}
        />
      </CardContent>
    </Card>
  );
}

const ACTIVITY_TONE = {
  ok: 'border-l-success',
  failed: 'border-l-destructive',
  info: 'border-l-border',
} as const satisfies Record<ActivityEntry['status'], string>;

/**
 * The timeline, and a way in from every line of it.
 *
 * `attempt_events` constrains every row to exactly one attempt, so every entry
 * has somewhere to go — `/deploys/:id` or `/builds/:id`. An entry that led
 * nowhere would be the one thing on this screen a reader could not act on.
 */
function Activity({
  entries,
  onNavigate,
}: {
  entries: readonly ActivityEntry[];
  onNavigate?: (path: string) => void;
}) {
  return (
    <Card>
      <SectionHeader eyebrow="Recent activity" title="What happened" />
      <CardContent className="flex flex-col gap-2.5 pt-0">
        {entries.length === 0 ? (
          <EmptyState title="Nothing has happened yet.">
            Build and deploy events land here as they arrive.
          </EmptyState>
        ) : (
          entries.map((entry) => (
            <ActivityRow
              key={`${entry.title}-${entry.when}-${entry.deployId ?? entry.buildId}`}
              entry={entry}
              onNavigate={onNavigate}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}

function ActivityRow({
  entry,
  onNavigate,
}: {
  entry: ActivityEntry;
  onNavigate?: (path: string) => void;
}) {
  const path =
    entry.deployId !== null
      ? `/deploys/${entry.deployId}`
      : entry.buildId !== null
        ? `/builds/${entry.buildId}`
        : null;

  const body = (
    <>
      <div className="flex items-baseline gap-2">
        <p className="text-sm font-medium">{entry.title}</p>
        <span className="ml-auto font-mono text-xs text-muted-foreground">
          {entry.when}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{entry.detail}</p>
    </>
  );

  if (path === null || !onNavigate) {
    return (
      <div className={cn('border-l-2 pl-3', ACTIVITY_TONE[entry.status])}>
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onNavigate(path)}
      className={cn(
        'border-l-2 pl-3 text-left hover:bg-secondary/50',
        ACTIVITY_TONE[entry.status],
      )}
    >
      {body}
    </button>
  );
}

/**
 * A Component's output surface — one of §17's three, kept honestly distinct.
 *
 * §17 draws two lines this branch exists to hold. **A job is not a stream but a
 * list of executions**: an execution terminates, so it is attempt-shaped, and
 * the tail pipe covers services only. And a **`static` Target gets an honest
 * empty state** rather than a disabled tab, because there is no process to
 * follow rather than a stream that happens to be quiet.
 *
 * For the one case that *is* a stream, the view **follows the Component**:
 * Deploys are markers on it, never a filter, which is the only shape that lets
 * a human read across a rollback boundary. Its reach is stated — §17 makes
 * `logHistory` a duration rather than a capability, so a Target never lacks
 * logs, it only has a shorter memory, and saying how short is the whole point.
 */
function Runtime({
  view,
  onNavigate,
}: {
  view: WorkspaceView;
  onNavigate?: (path: string) => void;
}) {
  const runtime = view.runtime;
  const latestDeployId = view.latestDeployId;

  return (
    <Card>
      <SectionHeader
        eyebrow="Component output"
        title={TITLE[runtime.kind]}
        action={ACTION[runtime.kind]}
        onAction={
          latestDeployId && onNavigate
            ? () => onNavigate(`/deploys/${latestDeployId}`)
            : undefined
        }
      />
      <CardContent className="pt-0">
        {runtime.kind === 'none' ? (
          <EmptyState title="No runtime exists for this Component.">
            {runtime.because}
          </EmptyState>
        ) : runtime.kind === 'executions' ? (
          <>
            {runtime.executions.map((execution) => (
              <Row
                key={execution.name}
                badge={
                  <Badge tone={EXECUTION_TONE[execution.outcome]}>
                    {execution.outcome}
                  </Badge>
                }
                title={execution.name}
                detail={`${execution.detail} · ${execution.when}`}
              />
            ))}
            <p className="pt-2 text-xs text-muted-foreground">
              The last {runtime.retained} executions are kept. Depth is
              configured on the Target, not stored here.
            </p>
          </>
        ) : (
          <>
            <LogPane lines={runtime.lines} />
            <p className="pt-2 text-xs text-muted-foreground">
              This Target keeps {runtime.reach} of history. Deploys are markers
              on this stream, never a filter.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

const TITLE = {
  stream: 'Runtime',
  executions: 'Recent runs',
  none: 'Runtime',
} as const satisfies Record<WorkspaceView['runtime']['kind'], string>;

const ACTION = {
  stream: 'Open logs',
  executions: 'All executions',
  none: 'Build activity',
} as const satisfies Record<WorkspaceView['runtime']['kind'], string>;

const EXECUTION_TONE = {
  passed: 'success',
  failed: 'destructive',
  running: 'warning',
} as const;
