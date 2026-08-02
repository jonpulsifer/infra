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
  Globe,
  Server,
  X,
  Zap,
} from 'lucide-react';
import { useState } from 'react';
import type { ComponentKind } from '../../../domain/desired-state.ts';
import type { InputOf } from '../../client.ts';
import type { PendingTargetConnection, TargetListItem } from '../../model.ts';
import { Badge, Dot } from '../../ui/badge.tsx';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, Eyebrow } from '../../ui/card.tsx';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../../ui/collapsible.tsx';
import { cn } from '../../ui/utils.ts';
import { ConnectTargetForm } from './connect.tsx';

type ConnectTargetInput = InputOf<'connectTarget'>;

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

export function TargetList({
  targets,
  pending,
  connecting,
  error,
  onConnect,
}: {
  targets: readonly TargetListItem[];
  pending: readonly PendingTargetConnection[];
  connecting: boolean;
  error: string | null;
  onConnect: (input: ConnectTargetInput) => void;
}) {
  const configured = targets.filter((target) => target.configured);

  return (
    <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-5 px-5 py-6">
      <header>
        <Eyebrow>Targets</Eyebrow>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          Deployment targets
        </h1>
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">
          Where Spindrift can deploy apps. Identities and rank come from the
          installation manifest; connecting one is what fills in how to reach
          it, and health is the standing checklist afterwards.
        </p>
      </header>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {pending.length > 0 ? (
        <PendingConnections
          pending={pending}
          connecting={connecting}
          onConnect={onConnect}
        />
      ) : null}

      {configured.length === 0 && pending.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-sm text-muted-foreground">
              No Targets are configured for this installation.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {configured.map((target) => (
            <TargetCard key={target.id} target={target} />
          ))}
        </div>
      )}
    </div>
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
          <div key={entry.name}>
            <div className="flex flex-wrap items-center gap-3 px-4 py-3">
              <AlertTriangle
                aria-hidden="true"
                className="size-4 shrink-0 text-warning"
              />
              <span className="font-mono text-sm font-medium">
                {entry.name}
              </span>
              <Badge tone="idle">
                {entry.kind === 'kubernetes' ? 'cluster' : 'cloud project'}
              </Badge>
              <span className="text-xs text-muted-foreground">
                declared in the manifest, never connected
              </span>
              <Button
                size="sm"
                variant={open === entry.name ? 'ghost' : 'default'}
                className="ml-auto"
                onClick={() =>
                  setOpen((current) =>
                    current === entry.name ? null : entry.name,
                  )
                }
              >
                {open === entry.name ? 'Cancel' : 'Finish setup'}
              </Button>
            </div>
            {open === entry.name ? (
              <div className="border-t border-border-soft bg-secondary/40 px-4 py-4">
                <ConnectTargetForm
                  kind={entry.kind}
                  name={entry.name}
                  targets={entry.targets}
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

function TargetCard({ target }: { target: TargetListItem }) {
  const unhealthy = target.health !== 'healthy';
  const [checklistOpen, setChecklistOpen] = useState(unhealthy);
  const met = target.prerequisites.filter((item) => item.met).length;

  return (
    <Card className={cn(unhealthy && 'border-destructive/40')}>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
          <div className="flex items-center gap-3">
            <Activity
              aria-hidden="true"
              className={cn(
                'size-5',
                target.health === 'healthy'
                  ? 'text-success'
                  : 'text-destructive',
              )}
            />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold">{target.name}</span>
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
                <span className="font-mono text-xs text-muted-foreground">
                  {target.canonical}
                </span>
                <span className="text-xs text-subtle">rank {target.rank}</span>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-1.5 sm:ml-auto">
            {target.kinds.map((kind) => (
              <span
                key={kind}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground"
              >
                {kindIcon(kind)}
                {kind}
              </span>
            ))}
          </div>
        </div>

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
                <div
                  key={item.name}
                  className="flex items-start gap-2 rounded-md px-2 py-1.5 text-xs"
                >
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
                    <span className="text-muted-foreground">
                      — {item.detail}
                    </span>
                  ) : null}
                </div>
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
