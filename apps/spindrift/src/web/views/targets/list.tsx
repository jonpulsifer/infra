/**
 * The Targets list (§18).
 *
 * Shows every deployment Target the control plane knows about, its adapter
 * type, rank, health, supported kinds, and canonical hostname pattern. This
 * is an admin view — Target identities and rank come from the manifest (§7),
 * while connection facts come from `connectTarget` (§14), not from this UI.
 *
 * The view exists because §18 names **Apps / Datastores / Targets** as the
 * global navigation, and a Target's health, rank, and canonical pattern are
 * the context a developer needs when choosing where to deploy.
 */
import { Activity, Globe, Server, Zap } from 'lucide-react';
import type { ComponentKind } from '../../../domain/desired-state.ts';
import type { TargetListItem } from '../../model.ts';
import { Badge } from '../../ui/badge.tsx';
import { Card, CardContent, Eyebrow } from '../../ui/card.tsx';
import { cn } from '../../ui/utils.ts';

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
}: {
  targets: readonly TargetListItem[];
}) {
  return (
    <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-5 px-5 py-6">
      <header>
        <Eyebrow>Targets</Eyebrow>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          Deployment targets
        </h1>
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">
          Where Spindrift can deploy apps. Targets are declared in the manifest
          and connected by an operator — this surface shows their current health
          and capabilities.
        </p>
      </header>

      {targets.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-sm text-muted-foreground">
              No Targets are configured for this installation.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {targets.map((target) => (
            <Card key={target.name}>
              <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
                <div className="flex items-center gap-3">
                  <Activity
                    aria-hidden="true"
                    className={cn(
                      'size-5',
                      target.health === 'healthy'
                        ? 'text-green-600 dark:text-green-400'
                        : 'text-red-500 dark:text-red-400',
                    )}
                  />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold">
                        {target.name}
                      </span>
                      <Badge
                        tone={
                          target.health === 'healthy'
                            ? 'success'
                            : 'destructive'
                        }
                      >
                        {target.health}
                      </Badge>
                      <Badge tone="idle">{target.adapter}</Badge>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="font-mono text-xs text-muted-foreground">
                        {target.canonical}
                      </span>
                      <span className="text-xs text-subtle">
                        rank {target.rank}
                      </span>
                    </div>
                    {target.health === 'unhealthy' &&
                      target.prerequisiteFailures &&
                      target.prerequisiteFailures.length > 0 && (
                        <div className="mt-2 flex flex-col gap-1 text-xs text-red-600 dark:text-red-400">
                          {target.prerequisiteFailures.map((failure, idx) => (
                            <p key={idx}>{failure}</p>
                          ))}
                        </div>
                      )}
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
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
