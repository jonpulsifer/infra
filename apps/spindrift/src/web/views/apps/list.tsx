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
 */
import { ExternalLink, Globe, Plus, Server, Zap } from 'lucide-react';
import type { AppListItem, DeployPhase } from '../../model.ts';
import { Badge } from '../../ui/badge.tsx';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, Eyebrow } from '../../ui/card.tsx';
import { cn } from '../../ui/utils.ts';

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

export function AppList({
  apps,
  onNavigate,
}: {
  apps: readonly AppListItem[];
  onNavigate: (path: string) => void;
}) {
  return (
    <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-5 px-5 py-6">
      <header className="flex flex-wrap items-end gap-4">
        <div>
          <Eyebrow>Apps</Eyebrow>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Your apps
          </h1>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
            Every App the control plane knows about, with its current state.
          </p>
        </div>
        <div className="ml-auto">
          <Button onClick={() => onNavigate('/apps/new')}>
            <Plus aria-hidden="true" className="size-4" /> New App
          </Button>
        </div>
      </header>

      {apps.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-sm text-muted-foreground">
              No apps yet. Deploy your first one to get started.
            </p>
            <Button className="mt-4" onClick={() => onNavigate('/apps/new')}>
              <Plus aria-hidden="true" className="size-4" /> Deploy a new app
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {apps.map((app) => (
            <button
              key={app.name}
              type="button"
              onClick={() => onNavigate(`/apps/${app.name}`)}
              className={cn(
                'flex items-center gap-4 rounded-lg border border-border bg-card px-4 py-3.5 text-left transition-colors',
                'hover:border-primary hover:bg-secondary/60',
              )}
            >
              {kindIcon(app.kind)}

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold">{app.name}</span>
                  <Badge tone={phaseTone(app.phase)}>
                    {app.phase.toLowerCase()}
                  </Badge>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                  <span className="font-mono text-xs text-muted-foreground">
                    {app.target}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {app.source}
                  </span>
                </div>
              </div>

              <div className="hidden flex-col items-end gap-0.5 sm:flex">
                <span className="font-mono text-xs text-muted-foreground">
                  {app.url}
                </span>
                <span className="text-xs text-subtle">{app.release}</span>
              </div>

              {app.urlLive ? (
                <ExternalLink
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
              ) : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
