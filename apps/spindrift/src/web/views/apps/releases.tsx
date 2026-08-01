/**
 * The releases list (§2, §6).
 *
 * §2 makes "one Build → many Deploys" the thing that "makes rollback-without-
 * rebuild possible", and §6 makes a rollback "an ordinary deploy — a newer
 * intent row pointing at an older Build". Neither sentence is reachable from a
 * screen that shows only what is live now: choosing the older Build means
 * reading the release that named it.
 *
 * Every row is one immutable answer to "what was live then" — its Build, its
 * commit, and the config it pinned are what it delivered, and nothing edits a
 * Deploy row into a different release. So a row is addressable, and clicking
 * one opens that release rather than a filtered view of the current one.
 *
 * **`current` is not the same as `LIVE`.** A LIVE Deploy that a newer intent
 * superseded is still LIVE — what changed is that it is no longer what should
 * be running — and only §6's desired row knows the difference. The list marks
 * the current one explicitly rather than letting the phase imply it.
 */
import { ChevronRight, Undo2 } from 'lucide-react';
import { EmptyState } from '../../components/log-pane.tsx';
import type { DeployListItem, DeployPhase } from '../../model.ts';
import { Badge } from '../../ui/badge.tsx';
import { Button } from '../../ui/button.tsx';
import { cn } from '../../ui/utils.ts';

function phaseTone(
  phase: DeployPhase,
): 'success' | 'warning' | 'destructive' | 'idle' {
  if (phase === 'LIVE') return 'success';
  if (phase === 'FAILED') return 'destructive';
  return 'warning';
}

export function Releases({
  deploys,
  onNavigate,
  onRollback,
  rollingBack = null,
}: {
  deploys: readonly DeployListItem[];
  onNavigate?: (path: string) => void;
  onRollback?: (release: DeployListItem) => void;
  /** The release id a rollback is in flight for, if any. */
  rollingBack?: number | null;
}) {
  if (deploys.length === 0) {
    return (
      <EmptyState title="No releases yet.">
        Every deploy writes one immutable release here — its Build, its commit,
        and the configuration it pinned.
      </EmptyState>
    );
  }

  return (
    <div className="flex max-h-[420px] flex-col overflow-y-auto">
      {deploys.map((release) => (
        <Row
          key={release.id}
          release={release}
          onNavigate={onNavigate}
          onRollback={onRollback}
          rollingBack={rollingBack}
        />
      ))}
    </div>
  );
}

function Row({
  release,
  onNavigate,
  onRollback,
  rollingBack,
}: {
  release: DeployListItem;
  onNavigate?: (path: string) => void;
  onRollback?: (release: DeployListItem) => void;
  rollingBack: number | null;
}) {
  const detail = [
    release.target,
    release.when,
    release.configVersion
      ? `config ${release.configVersion.slice(0, 8)}`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="flex items-center gap-3 border-b border-border-soft py-2.5 last:border-b-0">
      <Badge tone={phaseTone(release.phase)}>{release.phase}</Badge>
      <button
        type="button"
        onClick={() => onNavigate?.(`/deploys/${release.id}`)}
        disabled={!onNavigate}
        className="min-w-0 flex-1 text-left disabled:cursor-default"
      >
        <p className="truncate text-sm font-medium">
          Deploy {release.id}
          <span className="ml-2 font-mono text-xs text-muted-foreground">
            {release.commit.slice(0, 12)}
          </span>
          {release.current ? (
            <span
              className={cn(
                'ml-2 rounded-sm border px-1.5 py-0.5',
                'text-[10px] font-semibold uppercase tracking-[0.07em]',
                'text-accent-foreground',
              )}
            >
              current
            </span>
          ) : null}
        </p>
        <p className="truncate text-xs text-muted-foreground">{detail}</p>
      </button>
      {release.rollbackable && onRollback ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => onRollback(release)}
          disabled={rollingBack !== null}
        >
          <Undo2 aria-hidden="true" className="size-3.5" />
          {rollingBack === release.id ? 'Rolling back…' : 'Roll back'}
        </Button>
      ) : (
        <ChevronRight
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground"
        />
      )}
    </div>
  );
}
