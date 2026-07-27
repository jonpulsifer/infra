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
import { EmptyState, LogPane } from '../../components/log-pane.tsx';
import { PhasePill } from '../../components/status.tsx';
import type {
  ActivityEntry,
  ComponentView,
  DatastoreView,
  WorkspaceView,
} from '../../model.ts';
import { Badge } from '../../ui/badge.tsx';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardHeader, Eyebrow } from '../../ui/card.tsx';
import { cn } from '../../ui/utils.ts';

export function Workspace({ view }: { view: WorkspaceView }) {
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
          <Button variant="outline" asChild>
            <a href={`https://${view.url}`}>
              Open app <ExternalLink aria-hidden="true" />
            </a>
          </Button>
          <Button>{primary?.kind === 'job' ? 'Run now' : 'Deploy'}</Button>
        </div>
      </header>

      <Hero view={view} />

      <div className="grid gap-4 md:grid-cols-2">
        <Components components={view.components} />
        <Datastores datastores={view.datastores} />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Activity entries={view.activity} />
        <Runtime view={view} />
      </div>
    </div>
  );
}

/** Live state and URL on the left; placement on the right. */
function Hero({ view }: { view: WorkspaceView }) {
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

function SectionHeader({
  eyebrow,
  title,
  action,
}: {
  eyebrow: string;
  title: string;
  action: string;
}) {
  return (
    <CardHeader>
      <div>
        <Eyebrow>{eyebrow}</Eyebrow>
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
      </div>
      <Button variant="outline" size="sm" className="ml-auto">
        {action}
      </Button>
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

const ACTIVITY_TONE = {
  ok: 'border-l-success',
  failed: 'border-l-destructive',
  info: 'border-l-border',
} as const satisfies Record<ActivityEntry['status'], string>;

function Activity({ entries }: { entries: readonly ActivityEntry[] }) {
  return (
    <Card>
      <SectionHeader
        eyebrow="Recent activity"
        title="What happened"
        action="View all"
      />
      <CardContent className="flex flex-col gap-2.5 pt-0">
        {entries.map((entry) => (
          <div
            key={`${entry.title}-${entry.when}`}
            className={cn('border-l-2 pl-3', ACTIVITY_TONE[entry.status])}
          >
            <div className="flex items-baseline gap-2">
              <p className="text-sm font-medium">{entry.title}</p>
              <span className="ml-auto font-mono text-xs text-muted-foreground">
                {entry.when}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">{entry.detail}</p>
          </div>
        ))}
      </CardContent>
    </Card>
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
function Runtime({ view }: { view: WorkspaceView }) {
  const runtime = view.runtime;

  return (
    <Card>
      <SectionHeader
        eyebrow="Component output"
        title={TITLE[runtime.kind]}
        action={ACTION[runtime.kind]}
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
