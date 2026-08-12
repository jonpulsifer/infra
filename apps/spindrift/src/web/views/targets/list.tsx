/**
 * The Targets surface (§13, §18).
 *
 * It used to be a read-only list whose own header said Targets "are connected
 * by an operator" — true, and there was no way to be that operator here.
 * `connectTarget` existed as a command with no screen, so an installation with
 * a manifest-seeded Target and no connection had a permanently unhealthy row
 * and nothing to press.
 *
 * So this screen is two things at once, in the order they matter:
 *
 * 1. **What is left to do.** A Target whose `connection` is null is a manifest
 *    seed nobody finished, and it sits at the top with the form that finishes
 *    it. Cloud projects are grouped back into one act, because that is what
 *    §13 makes them.
 * 2. **What is running, and what was checked.** Each Target carries its whole
 *    standing checklist behind a disclosure, met rows included. §13's
 *    "an unmet item makes the Target a non-candidate with a stated reason" only
 *    helps if the reason is somewhere a person looks, and "why can I not deploy
 *    here" should be answered on the Target rather than in a deploy failure.
 *
 * The checklist is collapsed on healthy and open on unhealthy, which is §18's
 * rule for the build log applied to the same question: the one time it says
 * something other than "fine" is the time it should not need a click.
 */
import {
  Activity,
  AlertTriangle,
  Check,
  ChevronRight,
  Copy,
  GitPullRequest,
  Globe,
  Plus,
  Server,
  X,
  Zap,
} from 'lucide-react';
import { useState } from 'react';
import type { TargetAdapter } from '../../../config/manifest.schema.ts';
import type { ComponentKind } from '../../../domain/desired-state.ts';
import { surfacesToProbe, type VesselRole } from '../../../domain/vessel.ts';
import type { LogoName } from '../../client/logos/index.ts';
import { command, type InputOf, type OutputOf } from '../../client.ts';
import type {
  PendingTargetConnection,
  PrerequisiteRowView,
  TargetListItem,
  VesselListItem,
} from '../../model.ts';
import { Badge, Dot } from '../../ui/badge.tsx';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, Eyebrow } from '../../ui/card.tsx';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../../ui/collapsible.tsx';
import { Logo } from '../../ui/logo.tsx';
import { cn } from '../../ui/utils.ts';
import { ConnectTargetForm } from './connect.tsx';

type ConnectTargetInput = InputOf<'connectTarget'>;

/**
 * The mark for a Target's adapter.
 *
 * Both cloud adapters get the same one on purpose: §13 makes a cloud Target a
 * matched `<name>-cloudrun`/`<name>-static` pair on one project, so what a
 * reader is placing work on is Google Cloud either way. `adapter` is a string
 * on the view model rather than the enum, so a Target the server grew and this
 * table has not is a missing key, not a crash — `TargetCard` keeps the generic
 * health icon for that case.
 */
const ADAPTER_LOGO: Record<string, LogoName> = {
  kubernetes: 'kubernetes',
  cloudrun: 'google-cloud',
  static: 'google-cloud',
};

function kindIcon(kind: ComponentKind) {
  switch (kind) {
    case 'website':
      return <Globe aria-hidden="true" className="size-3.5" />;
    case 'job':
      return <Zap aria-hidden="true" className="size-3.5" />;
    default:
      return <Server aria-hidden="true" className="size-3.5" />;
  }
}

/**
 * What a connect established is not on the boundary it probed.
 *
 * Stated rather than left to be inferred from a Target that is not in the list:
 * "this project has no Cloud Run" and "the connect only half worked" look
 * identical from a list of what exists, and only one of them is true.
 */
function AbsentSurfaces({ absent }: { absent: readonly string[] }) {
  if (absent.length === 0) return null;
  return (
    <div className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-sm">
      {absent.map((sentence) => (
        <p key={sentence}>{sentence}</p>
      ))}
    </div>
  );
}

/**
 * One checklist row, and — where it is unmet — the change that clears it.
 *
 * §13 makes an unmet item "a non-candidate with a stated reason", and a reason
 * is the diagnosis rather than the fix. What is rendered underneath one here is
 * the Terraform that clears it and the path it belongs at, so the operator's
 * next move is copy-and-commit or press the button, rather than work out from a
 * sentence what a cloud wants.
 *
 * **"No generated remediation" is a state with a sentence, never an empty
 * box.** Most rows are cleared by something other than Terraform, and rendering
 * that as a blank disclosure would say a change exists and is empty — the same
 * laundering `cloud-discovery.ts` keeps `found: []` and `unavailable` apart to
 * prevent.
 */
function ChecklistRow({
  vessel,
  adapter,
  item,
}: {
  readonly vessel: string;
  /** Omitted for a boundary's own row, which is not on any surface. */
  readonly adapter?: TargetAdapter;
  readonly item: PrerequisiteRowView;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-md px-2 py-1.5 text-xs">
      <div className="flex items-start gap-2">
        {item.met ? (
          <Check
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0 text-success"
          />
        ) : (
          <X
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0 text-destructive"
          />
        )}
        <span className="font-mono">{item.name}</span>
        {item.detail ? (
          <span className="text-muted-foreground">— {item.detail}</span>
        ) : null}
      </div>
      {item.remediation === undefined ? null : item.remediation.kind ===
        'none' ? (
        <p className="pl-5 text-[11px] text-subtle">
          No generated remediation — {item.remediation.reason}
        </p>
      ) : (
        <RemediationDisclosure
          vessel={vessel}
          {...(adapter === undefined ? {} : { adapter })}
          prerequisite={item.name}
          remediation={item.remediation}
        />
      )}
    </div>
  );
}

type OpenState =
  | { readonly type: 'idle' }
  | { readonly type: 'opening' }
  | { readonly type: 'opened'; readonly number: number; readonly path: string }
  | { readonly type: 'error'; readonly message: string };

/** The stanza, where it belongs, and the two ways to take it from here. */
function RemediationDisclosure({
  vessel,
  adapter,
  prerequisite,
  remediation,
}: {
  readonly vessel: string;
  readonly adapter?: TargetAdapter;
  readonly prerequisite: PrerequisiteRowView['name'];
  readonly remediation: Extract<
    NonNullable<PrerequisiteRowView['remediation']>,
    { kind: 'generated' }
  >;
}) {
  /*
    Open, and collapsible afterwards — the rule the checklist above it already
    follows: "the one time it says something other than fine is the time it
    should not need a click." Only an unmet row has a remediation at all, so
    every one of these is that time; the disclosure is what lets an operator
    who has read one put it away, not a gate in front of it.
  */
  const [open, setOpen] = useState(true);
  const [copied, setCopied] = useState(false);
  const [state, setState] = useState<OpenState>({ type: 'idle' });
  const destination = remediation.destination;

  const copy = async () => {
    await navigator.clipboard.writeText(remediation.terraform);
    setCopied(true);
  };

  const openPullRequest = async () => {
    setState({ type: 'opening' });
    try {
      const result = await command('openPrerequisiteRemediation', {
        vessel,
        ...(adapter === undefined ? {} : { adapter }),
        prerequisite,
      });
      setState(
        result.ok
          ? {
              type: 'opened',
              number: result.value.pullRequest,
              path: result.value.path,
            }
          : { type: 'error', message: result.failure.message },
      );
    } catch (cause) {
      setState({
        type: 'error',
        message:
          cause instanceof Error
            ? cause.message
            : 'Opening the pull request failed',
      });
    }
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="pl-5">
      <CollapsibleTrigger className="group flex w-full items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground">
        <ChevronRight
          aria-hidden="true"
          className="size-3 transition-transform group-data-[state=open]:rotate-90"
        />
        Remediation
        <span className="ml-auto font-mono">
          {destination.kind === 'root' ? destination.path : 'no Terraform root'}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1.5 flex flex-col gap-2">
        <p className="text-[11px] text-muted-foreground">
          {remediation.summary}
        </p>
        {destination.kind === 'absent' ? (
          /*
            The honest arm. There is no file to append to and no pull request
            to open, so the screen says which boundary has no root rather than
            naming a directory nothing in that repository agreed to.
          */
          <p className="text-[11px] text-subtle">
            {vessel} has no Terraform root. This is what one would contain, in a{' '}
            <span className="font-mono">{destination.file}</span> inside it.
          </p>
        ) : null}
        <pre className="overflow-x-auto rounded-md border border-border bg-background px-3 py-2 font-mono text-[11px]">
          {remediation.terraform}
        </pre>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => void copy()}>
            <Copy aria-hidden="true" className="size-3.5" />
            {copied ? 'Copied' : 'Copy'}
          </Button>
          {destination.kind === 'root' ? (
            <Button
              size="sm"
              variant="outline"
              disabled={state.type === 'opening' || state.type === 'opened'}
              onClick={() => void openPullRequest()}
            >
              <GitPullRequest aria-hidden="true" className="size-3.5" />
              {state.type === 'opening'
                ? 'Opening…'
                : state.type === 'opened'
                  ? `Opened #${state.number}`
                  : 'Open a pull request'}
            </Button>
          ) : null}
          {/*
            The whole of what a merged pull request does, and what it does not.
            Applying is what clears the row, and the standing loop is what
            notices — so there is nothing here to press afterwards.
          */}
          <span className="text-[11px] text-subtle">
            Spindrift changes nothing here. Applying this is what clears the
            row, and the standing check is what notices.
          </span>
        </div>
        {state.type === 'opened' ? (
          <p className="text-[11px] text-muted-foreground">
            Pull request #{state.number} adds this to{' '}
            <span className="font-mono">{state.path}</span>. Nothing else was
            written, and this row stays unmet until the boundary says otherwise.
          </p>
        ) : null}
        {state.type === 'error' ? (
          <p className="text-[11px] text-destructive">{state.message}</p>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function TargetList({
  targets,
  pending,
  vessels,
  connecting,
  error,
  absent = [],
  onConnect,
  onChanged,
  onNavigate,
  embedded = false,
}: {
  targets: readonly TargetListItem[];
  pending: readonly PendingTargetConnection[];
  /** The boundaries themselves, with the checklist that is theirs. */
  vessels: readonly VesselListItem[];
  connecting: boolean;
  error: string | null;
  /** One sentence per surface the last connect found was not there. */
  absent?: readonly string[];
  onConnect: (input: ConnectTargetInput) => void;
  onChanged?: () => void;
  onNavigate?: (path: string) => void;
  embedded?: boolean;
}) {
  const configured = targets.filter((target) => target.configured);
  const [adding, setAdding] = useState(false);
  /**
   * Carried into the add flow from whatever this installation already has.
   *
   * The pending entries hold the same proposal — it is derived per adapter kind,
   * not per Target — so taking the first cluster one is taking the only one
   * there is. With no pending entry there is nothing seeded either, and an empty
   * proposal is the honest input: nothing has been learnt to carry.
   */
  const clusterProposal = pending.find((entry) => entry.kind === 'cluster')
    ?.proposal ?? { carriedFrom: null };

  if (embedded) {
    const clusters = configured.filter(
      (target) => target.adapter === 'kubernetes',
    );
    const cloud = configured.filter(
      (target) => target.adapter !== 'kubernetes',
    );
    const clusterPending = pending.filter((entry) => entry.kind === 'cluster');
    const cloudPending = pending.filter(
      (entry) => entry.kind === 'gcp-project',
    );

    return (
      <>
        {error ? (
          <section className="py-4 text-sm text-destructive">{error}</section>
        ) : null}
        {absent.length > 0 ? (
          <section className="py-4">
            <AbsentSurfaces absent={absent} />
          </section>
        ) : null}
        <VesselChecklists vessels={vessels} />
        <ProviderTargets
          name="Google Cloud"
          logo="google-cloud"
          description="Declared projects become explicit Cloud Run and static Targets. Consent and project discovery are not configured in this build."
          targets={cloud}
          pending={cloudPending}
          connecting={connecting}
          onConnect={onConnect}
          onChanged={onChanged}
          empty="Declare a cloud project in Installation to make its real connection workflow available here."
        />
        <ProviderTargets
          name="Kubernetes"
          logo="kubernetes"
          description="Declared clusters use explicit control-plane connection facts today. An automated GitOps bootstrap handoff is not configured in this build."
          targets={clusters}
          pending={clusterPending}
          connecting={connecting}
          onConnect={onConnect}
          onChanged={onChanged}
          empty="Add a cluster with the connection facts Spindrift can verify, or declare it in Installation first."
          adding={adding}
          onAddingChange={setAdding}
          clusterProposal={clusterProposal}
        />
        <section className="grid gap-5 py-6 xl:grid-cols-[240px_minmax(0,1fr)] xl:gap-8">
          <div>
            <h3 className="font-semibold">Target suggestion order</h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Lower ranks are suggested first. Placement requirements can still
              select another eligible Target.
            </p>
          </div>
          <div>
            <ol className="divide-y divide-border-soft border-y border-border-soft">
              {[...configured]
                .sort((left, right) => left.rank - right.rank)
                .map((target) => (
                  <li
                    key={target.id}
                    className="flex items-center gap-3 py-2.5 text-sm"
                  >
                    <span className="grid size-6 place-items-center rounded-sm bg-secondary font-mono text-xs text-muted-foreground">
                      {target.rank}
                    </span>
                    <span className="font-medium">{target.vessel}</span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {target.adapter}
                    </span>
                  </li>
                ))}
            </ol>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                Ranking is installation policy; it is not changed by a runtime
                connection command.
              </p>
              {onNavigate ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onNavigate('/settings/installation')}
                >
                  Edit installation policy
                </Button>
              ) : null}
            </div>
          </div>
        </section>
      </>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-5 px-5 py-6">
      <header className="flex flex-wrap items-end gap-4">
        <div>
          <Eyebrow>Targets</Eyebrow>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Deployment targets
          </h1>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
            Where Spindrift can deploy apps. Give a cluster's address and
            Spindrift reads what it runs; what you include is what an App's
            release blends into. The installation manifest declares the same
            thing, and health is the standing checklist afterwards.
          </p>
        </div>
      </header>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <AbsentSurfaces absent={absent} />

      <VesselChecklists vessels={vessels} />

      <TargetCollection
        targets={configured}
        pending={pending}
        connecting={connecting}
        onConnect={onConnect}
        onChanged={onChanged}
        empty="No Targets are configured. Add a cluster above, or declare one under targets: in the installation manifest."
        adding={adding}
        onAddingChange={setAdding}
        clusterProposal={clusterProposal}
      />
    </div>
  );
}

function ProviderTargets({
  name,
  logo,
  description,
  ...collection
}: {
  readonly name: string;
  readonly logo: LogoName;
  readonly description: string;
} & Parameters<typeof TargetCollection>[0]) {
  const connected = collection.targets.filter(
    (target) => target.status === 'connected',
  ).length;
  const needsAction = collection.pending.length > 0;
  const status = needsAction
    ? 'action needed'
    : connected > 0
      ? `${connected} connected`
      : 'not configured';

  return (
    <section className="grid gap-5 py-6 xl:grid-cols-[240px_minmax(0,1fr)] xl:gap-8">
      <div>
        <div className="flex items-center gap-2">
          <Logo name={logo} />
          <h3 className="font-semibold">{name}</h3>
        </div>
        <Badge
          className="mt-3"
          tone={needsAction ? 'warning' : connected > 0 ? 'success' : 'idle'}
        >
          <Dot /> {status}
        </Badge>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          {description}
        </p>
      </div>
      <TargetCollection {...collection} />
    </section>
  );
}

function TargetCollection({
  targets,
  pending,
  connecting,
  onConnect,
  onChanged,
  empty,
  adding = false,
  onAddingChange,
  clusterProposal,
}: {
  readonly targets: readonly TargetListItem[];
  readonly pending: readonly PendingTargetConnection[];
  readonly connecting: boolean;
  readonly onConnect: (input: ConnectTargetInput) => void;
  readonly onChanged?: () => void;
  readonly empty: string;
  readonly adding?: boolean;
  readonly onAddingChange?: (adding: boolean) => void;
  readonly clusterProposal?: PendingTargetConnection['proposal'];
}) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {onAddingChange ? (
        <div className="flex justify-end">
          <Button
            size="sm"
            variant={adding ? 'ghost' : 'outline'}
            onClick={() => onAddingChange(!adding)}
          >
            {adding ? (
              'Cancel'
            ) : (
              <>
                <Plus aria-hidden="true" /> Add a cluster
              </>
            )}
          </Button>
        </div>
      ) : null}
      {adding && clusterProposal ? (
        <Card>
          <CardContent>
            <ConnectTargetForm
              kind="cluster"
              vessel=""
              vesselEditable
              surfaces={[]}
              proposal={clusterProposal}
              connecting={connecting}
              onConnect={onConnect}
              onCancel={() => onAddingChange?.(false)}
            />
          </CardContent>
        </Card>
      ) : null}
      {pending.length > 0 ? (
        <PendingConnections
          pending={pending}
          connecting={connecting}
          onConnect={onConnect}
        />
      ) : null}
      {targets.length === 0 && pending.length === 0 ? (
        <div className="border-y border-border-soft py-5 text-sm leading-6 text-muted-foreground">
          {empty}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {targets.map((target) => (
            <TargetCard
              key={target.id}
              target={target}
              connecting={connecting}
              onConnect={onConnect}
              onChanged={onChanged}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The boundaries themselves, with the checklist that is theirs.
 *
 * A section of its own rather than rows inside each Target card, because a
 * vessel may carry two surfaces and this is one fact about the boundary — folded
 * into the Targets it would be the same four answers rendered twice, which is
 * the duplication the vessel noun exists to remove.
 *
 * **Only the boundaries something is asked of appear here.** An app vessel's
 * catalogue is empty, so it has no rows, and a section listing it with nothing
 * under it would say something was checked when nothing was.
 */
function VesselChecklists({
  vessels,
}: {
  readonly vessels: readonly VesselListItem[];
}) {
  const assessed = vessels.filter(
    (vessel) => vessel.prerequisites.length > 0 || declaredRole(vessel.roles),
  );
  if (assessed.length === 0) return null;

  return (
    <section className="flex flex-col gap-2">
      <Eyebrow>Boundaries this installation is built on</Eyebrow>
      <Card className="divide-y divide-border">
        {assessed.map((vessel) => (
          <div key={vessel.name} className="flex flex-col gap-2 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Server aria-hidden="true" className="size-4 shrink-0" />
              <span className="text-sm font-semibold">{vessel.name}</span>
              <Badge tone="idle">{vessel.kind}</Badge>
              {vessel.prerequisites.length > 0 ? (
                <Badge
                  tone={vessel.health === 'healthy' ? 'success' : 'destructive'}
                >
                  <Dot />
                  {vessel.health}
                </Badge>
              ) : null}
              <span className="text-xs text-muted-foreground">
                {declaredRole(vessel.roles) ?? 'an ordinary deploy boundary'}
              </span>
            </div>
            {vessel.prerequisites.map((item) => (
              <ChecklistRow key={item.name} vessel={vessel.name} item={item} />
            ))}
            {/*
              Labelled as of-a-moment, for the reason a Target's checklist is:
              this is the last pass of the loop, and saying when stops it from
              being read as now. A boundary nobody has been past yet says so
              rather than reading as four questions that passed.
            */}
            <p className="text-[11px] text-subtle">
              {vessel.inspectedAt === null
                ? 'never inspected'
                : `last checked ${new Date(vessel.inspectedAt).toLocaleString()}`}
            </p>
          </div>
        ))}
      </Card>
    </section>
  );
}

/** The unfinished half, at the top, with the form that finishes it. */
function PendingConnections({
  pending,
  connecting,
  onConnect,
}: {
  pending: readonly PendingTargetConnection[];
  connecting: boolean;
  onConnect: (input: ConnectTargetInput) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);

  return (
    <section className="flex flex-col gap-2">
      <Eyebrow>Waiting to be connected</Eyebrow>
      <Card className="divide-y divide-border border-warning/40">
        {pending.map((entry) => (
          <div key={entry.vessel}>
            <div className="flex flex-wrap items-center gap-3 px-4 py-3">
              <AlertTriangle
                aria-hidden="true"
                className="size-4 shrink-0 text-warning"
              />
              <span className="font-mono text-sm font-medium">
                {entry.vessel}
              </span>
              <Badge tone="idle">
                {entry.kind === 'cluster' ? 'cluster' : 'cloud project'}
              </Badge>
              <span className="text-xs text-muted-foreground">
                declared in the manifest, never connected
              </span>
              <Button
                size="sm"
                variant={open === entry.vessel ? 'ghost' : 'default'}
                className="ml-auto"
                onClick={() =>
                  setOpen((current) =>
                    current === entry.vessel ? null : entry.vessel,
                  )
                }
              >
                {open === entry.vessel ? 'Cancel' : 'Finish setup'}
              </Button>
            </div>
            {open === entry.vessel ? (
              <div className="border-t border-border-soft bg-secondary/40 px-4 py-4">
                <ConnectTargetForm
                  kind={entry.kind}
                  vessel={entry.vessel}
                  surfaces={entry.surfaces}
                  proposal={entry.proposal}
                  connecting={connecting}
                  onConnect={onConnect}
                  onCancel={() => setOpen(null)}
                />
              </div>
            ) : null}
          </div>
        ))}
      </Card>
    </section>
  );
}

/**
 * What this Target's boundary is to the installation, as a sentence fragment —
 * `null` for an ordinary one.
 *
 * Both roles when a boundary carries both, because an installation whose
 * control plane runs where its shared services live is one boundary doing two
 * jobs, and naming only the first would leave the other unexplained.
 */
function declaredRole(roles: readonly VesselRole[]): string | null {
  const named = roles.flatMap((role) =>
    role === 'home'
      ? ['this installation’s home vessel']
      : role === 'controlPlane'
        ? ['where this control plane runs']
        : [],
  );
  return named.length === 0 ? null : named.join(' and ');
}

function TargetCard({
  target,
  connecting,
  onConnect,
  onChanged,
}: {
  target: TargetListItem;
  connecting: boolean;
  onConnect: (input: ConnectTargetInput) => void;
  onChanged?: () => void;
}) {
  const unhealthy = target.health !== 'healthy';
  const [checklistOpen, setChecklistOpen] = useState(unhealthy);
  const [editing, setEditing] = useState(false);
  const met = target.prerequisites.filter((item) => item.met).length;
  const logo = ADAPTER_LOGO[target.adapter];
  const declared = declaredRole(target.vesselRoles);

  return (
    <Card className={cn(unhealthy && 'border-destructive/40')}>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
          <div className="flex items-center gap-3">
            {/*
              The platform's own mark rather than a health glyph: health is
              already said twice on the row beside it, as a tone and as a word,
              and this anchor was the only place saying nothing about *where*
              the Target is. An adapter with no mark keeps the glyph.
            */}
            {logo ? (
              <Logo name={logo} />
            ) : (
              <Activity
                aria-hidden="true"
                className={cn(
                  'size-5',
                  target.health === 'healthy'
                    ? 'text-success'
                    : 'text-destructive',
                )}
              />
            )}
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold">{target.vessel}</span>
                <Badge tone={unhealthy ? 'destructive' : 'success'}>
                  <Dot />
                  {target.health}
                </Badge>
                <Badge tone="idle">{target.adapter}</Badge>
                {target.status === 'disconnected' ? (
                  <Badge tone="warning">disconnected</Badge>
                ) : null}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                {target.canonical === null ? (
                  // §9: `cloudrun` and `static` name their own workloads —
                  // core mints nothing here, so the honest boundary is this
                  // sentence, not a suffix core will never produce.
                  <span className="text-xs text-subtle">
                    platform names its own
                  </span>
                ) : (
                  <span className="font-mono text-xs text-muted-foreground">
                    {target.canonical}
                  </span>
                )}
                <span className="text-xs text-subtle">rank {target.rank}</span>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 sm:ml-auto">
            {target.kinds.map((kind) => (
              <span
                key={kind}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground"
              >
                {kindIcon(kind)}
                {kind}
              </span>
            ))}
            {/*
              The gateway, the authenticated edge, the config store and the
              address a record points at are all on this Target's connection,
              and until this button there was nowhere to correct one: the connect
              form was reachable only from an unconfigured seed. It is the same
              form and the same act — §13 makes connect idempotent by name — so
              the edit is a re-connect rather than a second way to write these.

              And a re-connect is a re-probe: it asks the boundary about every
              surface again, which is how a project whose Cloud Run API was off
              at connect time gets that Target once it is switched on.
            */}
            {declared === null && target.edit ? (
              <Button
                variant={editing ? 'ghost' : 'outline'}
                size="sm"
                onClick={() => setEditing((open) => !open)}
              >
                {editing ? 'Cancel' : 'Edit connection'}
              </Button>
            ) : null}
            {declared === null && target.status === 'connected' ? (
              <DisconnectTargetControl target={target} onChanged={onChanged} />
            ) : null}
          </div>
        </div>

        {/*
          §6: "drift is detected and surfaced, never silently corrected",
          applied to the manifest rather than to what it deploys. The row is what
          every deploy renders from and it wins over the document a boot writes
          back — but Settings still submits the whole document, so a Target that
          has been corrected here says which paths a save would take back.
          Paths, never values: a connection is credential-free today and this
          line does not lean on it staying that way.
        */}
        {target.connectionDivergence.length > 0 ? (
          <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-xs">
            <AlertTriangle
              aria-hidden="true"
              className="mt-0.5 size-3.5 shrink-0 text-warning"
            />
            <span>
              This Target's connection differs from what the installation
              manifest declares for it, at{' '}
              <span className="font-mono">
                {target.connectionDivergence.join(', ')}
              </span>
              . The row is what deploys render from and a restart leaves it
              alone; saving the manifest in Settings replaces it.
            </span>
          </div>
        ) : null}

        {declared === null ? null : (
          /*
            Read-only, and the sentence is why rather than a disabled button.
            This boundary reconciles from the mounted declaration on every boot,
            so an edit made here would survive exactly until the next restart —
            with the screen that accepted it then showing the old values and no
            reason. Disconnect is refused for the same reason one level down:
            `disconnectTarget` guards it, because neither pointer is a foreign
            key and nothing else would stop it.
          */
          <div className="flex items-start gap-2 rounded-md border border-border-soft bg-secondary/40 px-3 py-2 text-xs text-muted-foreground">
            <Server aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            <span>
              {target.vessel} is {declared}. It is declared by the installation
              manifest and reconciled from it on every boot, so its connection
              is edited there rather than here — and its surfaces cannot be
              disconnected.
            </span>
          </div>
        )}

        {editing && target.edit ? (
          <div className="rounded-md border border-border-soft bg-secondary/40 px-4 py-4">
            <ConnectTargetForm
              kind={target.edit.kind}
              vessel={target.vessel}
              {...(target.edit.kind === 'cluster'
                ? { apiServer: target.edit.apiServer }
                : target.edit.kind === 'vercel-team'
                  ? { team: target.edit.team }
                  : { project: target.edit.project })}
              // The whole act, not this card: one connect asks the boundary
              // about every surface its kind is probed for, and saying so is
              // what stops the confirmation from under-reporting what it
              // touches.
              surfaces={surfacesToProbe(target.edit.kind)}
              proposal={target.edit.proposal}
              connecting={connecting}
              onConnect={onConnect}
              onCancel={() => setEditing(false)}
            />
          </div>
        ) : null}

        {target.prerequisites.length > 0 ? (
          <Collapsible open={checklistOpen} onOpenChange={setChecklistOpen}>
            <CollapsibleTrigger className="group flex w-full items-center gap-1.5 border-t border-border-soft pt-3 text-xs text-muted-foreground hover:text-foreground">
              <ChevronRight
                aria-hidden="true"
                className="size-3.5 transition-transform group-data-[state=open]:rotate-90"
              />
              Checklist
              <span className="ml-auto font-mono">
                {met}/{target.prerequisites.length}
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2 flex flex-col gap-1">
              {target.prerequisites.map((item) => (
                <ChecklistRow
                  key={item.name}
                  vessel={target.vessel}
                  adapter={target.adapter}
                  item={item}
                />
              ))}
              {/*
                Labelled as of-a-moment on purpose. §18 makes "the live
                checklist must be labelled as the live view" load-bearing, and
                the inverse is the same rule: this one is a snapshot from the
                last pass of the loop, and saying when stops it from being read
                as now.
              */}
              <p className="mt-1 text-[11px] text-subtle">
                {target.inspectedAt === null
                  ? 'never inspected'
                  : `last checked ${new Date(target.inspectedAt).toLocaleString()}`}
              </p>
            </CollapsibleContent>
          </Collapsible>
        ) : null}
      </CardContent>
    </Card>
  );
}

type DisconnectImpact = OutputOf<'disconnectTarget'>;
type DisconnectState =
  | { readonly type: 'idle' }
  | { readonly type: 'reviewing' }
  | { readonly type: 'review'; readonly impact: DisconnectImpact }
  | { readonly type: 'disconnecting'; readonly impact: DisconnectImpact }
  | { readonly type: 'done'; readonly impact: DisconnectImpact }
  | { readonly type: 'error'; readonly message: string };

/** Inline impact review: disconnect strands Deploys and destroys no workload. */
function DisconnectTargetControl({
  target,
  onChanged,
}: {
  readonly target: TargetListItem;
  readonly onChanged?: () => void;
}) {
  const [state, setState] = useState<DisconnectState>({ type: 'idle' });

  const review = async () => {
    setState({ type: 'reviewing' });
    try {
      const result = await command('disconnectTarget', {
        vessel: target.vessel,
        adapter: target.adapter,
        confirm: false,
      });
      setState(
        result.ok
          ? { type: 'review', impact: result.value }
          : { type: 'error', message: result.failure.message },
      );
    } catch (cause) {
      setState({
        type: 'error',
        message: cause instanceof Error ? cause.message : 'Review failed',
      });
    }
  };

  const confirm = async (impact: DisconnectImpact) => {
    setState({ type: 'disconnecting', impact });
    try {
      const result = await command('disconnectTarget', {
        vessel: target.vessel,
        adapter: target.adapter,
        confirm: true,
      });
      if (!result.ok) {
        setState({ type: 'error', message: result.failure.message });
        return;
      }
      setState({ type: 'done', impact: result.value });
      onChanged?.();
    } catch (cause) {
      setState({
        type: 'error',
        message: cause instanceof Error ? cause.message : 'Disconnect failed',
      });
    }
  };

  if (state.type === 'idle') {
    return (
      <Button size="sm" variant="outline" onClick={() => void review()}>
        Disconnect
      </Button>
    );
  }
  if (state.type === 'reviewing') {
    return (
      <Button size="sm" variant="outline" disabled>
        Reviewing impact…
      </Button>
    );
  }
  if (state.type === 'error') {
    return (
      <div className="basis-full rounded-sm border border-destructive/40 bg-destructive-soft p-3 text-sm text-destructive">
        {state.message}{' '}
        <button
          type="button"
          className="underline"
          onClick={() => void review()}
        >
          Try again
        </button>
      </div>
    );
  }

  const count = state.impact.stranded.length;
  return (
    <div className="basis-full rounded-sm border border-warning/50 bg-warning-soft p-3 text-sm">
      <p className="font-semibold">
        {state.type === 'done'
          ? `${target.vessel}/${target.adapter} is disconnected.`
          : `Disconnecting will orphan ${count} current Deploy${count === 1 ? '' : 's'}.`}
      </p>
      {count > 0 ? (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          {state.impact.stranded.map((deploy) => (
            <li key={deploy.deployId}>
              {deploy.app} / {deploy.component} · Deploy #{deploy.deployId}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          No current Deploys will be orphaned.
        </p>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        Workloads keep serving. Spindrift stops reconciling them and marks the
        Target disconnected.
      </p>
      {state.type === 'review' ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setState({ type: 'idle' })}
          >
            Keep connected
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => void confirm(state.impact)}
          >
            Disconnect and orphan {count}
          </Button>
        </div>
      ) : state.type === 'disconnecting' ? (
        <Button className="mt-3" size="sm" variant="destructive" disabled>
          Disconnecting…
        </Button>
      ) : null}
    </div>
  );
}
