/**
 * The creation plan as rows that are already answered, each with an Edit that
 * opens its correction in place.
 */
import { AlertTriangle, Lock, Pencil } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Blocker } from '../../../../domain/creation-draft.ts';
import type {
  Auth,
  ComponentKind,
  Reach,
} from '../../../../domain/desired-state.ts';
import { Badge } from '../../../ui/badge.tsx';
import { Button } from '../../../ui/button.tsx';
import { Eyebrow } from '../../../ui/card.tsx';
import { cn } from '../../../ui/utils.ts';

export function Row({
  label,
  value,
  why,
  tone,
  open,
  onToggle,
  blockers,
  children,
}: {
  label: string;
  value: ReactNode;
  why?: ReactNode;
  /** Rendered beside the value — a health dot, a badge, an artifact type. */
  tone?: ReactNode;
  /** Owned by the parent, so only one row is open at a time. */
  open?: boolean;
  onToggle?: () => void;
  /** Unmet prerequisites, shown beside the row they are about. */
  blockers?: readonly Blocker[];
  /** The correction, if this row has one. Absent makes the row a fact. */
  children?: ReactNode;
}) {
  const showing = open === true && children !== undefined;
  return (
    <div className="border-b border-border-soft last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3">
        <span className="w-[84px] shrink-0 text-xs text-muted-foreground">
          {label}
        </span>
        <span className="font-mono text-sm">{value}</span>
        {tone}
        {children ? (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            aria-expanded={showing}
            onClick={onToggle}
          >
            {showing ? (
              'Done'
            ) : (
              <>
                <Pencil aria-hidden="true" /> Edit
              </>
            )}
          </Button>
        ) : null}
        {why ? (
          <p className="w-full text-xs text-muted-foreground">{why}</p>
        ) : null}
        {blockers?.map((blocker) => (
          <Blocked key={blocker.code + blocker.title} blocker={blocker} />
        ))}
      </div>
      {showing ? (
        <div className="border-t border-border-soft bg-secondary/40 px-4 py-4">
          {children}
        </div>
      ) : null}
    </div>
  );
}

function Blocked({ blocker }: { blocker: Blocker }) {
  return (
    <div className="mt-1 flex w-full items-start gap-2.5 rounded-md border border-destructive bg-destructive-soft px-3 py-2.5">
      <AlertTriangle
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-destructive"
      />
      <div>
        <p className="text-sm font-semibold text-destructive">
          {blocker.title}
        </p>
        <p className="text-xs text-subtle">{blocker.remediation}</p>
      </div>
    </div>
  );
}

/**
 * A selectable tile. An option that does not apply stays on screen, disabled,
 * with its reason.
 */
export function Choice({
  selected,
  disabled,
  title,
  note,
  onClick,
  children,
}: {
  selected: boolean;
  disabled?: boolean;
  title?: string;
  note?: string;
  onClick?: () => void;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex flex-col gap-1 rounded-md border px-3 py-2.5 text-left transition-colors',
        selected
          ? 'border-primary bg-accent'
          : 'border-border bg-card hover:border-primary',
        disabled && 'cursor-not-allowed opacity-60 hover:border-border',
      )}
    >
      {title ? <span className="text-sm font-semibold">{title}</span> : null}
      {note ? (
        <span className="text-xs text-muted-foreground">{note}</span>
      ) : null}
      {children}
    </button>
  );
}

export const KIND_NOTE = {
  service: 'A long-running process. A worker is a service that is not exposed.',
  website: 'Rendered to files or to a server image, depending on placement.',
  job: 'Runs to completion. A schedule is a field on it, never a separate noun.',
} as const satisfies Record<ComponentKind, string>;

/** Derived from {@link KIND_NOTE}, so a new kind cannot miss its tile. */
export const KINDS = Object.keys(KIND_NOTE) as readonly ComponentKind[];

/** A kind as a row states it, in the reader's words. */
export const KIND_LABEL = {
  // Not "Web service": a worker is a service with no route.
  service: 'Long-running service',
  website: 'Website',
  job: 'Job',
} as const satisfies Record<ComponentKind, string>;

export const REACH_NOTE = {
  none: 'No route. Nothing resolves to it, and it has no address to share.',
  private:
    'An address on your own network. Not reachable from the internet, whatever is in front of it.',
  public:
    'An address the internet reaches. The default is to put nothing in front of it.',
} as const satisfies Record<Reach, string>;

export const REACHES = Object.keys(REACH_NOTE) as readonly Reach[];

export const REACH_LABEL = {
  none: 'no address',
  private: 'only my network',
  public: 'anyone on the internet',
} as const satisfies Record<Reach, string>;

export const AUTH_NOTE = {
  none: 'Nothing authenticates in front of it. Whoever can reach it, can use it.',
  proxy:
    "The platform's own sign-in stands in front. Only where that place offers one.",
} as const satisfies Record<Auth, string>;

export const AUTHS = Object.keys(AUTH_NOTE) as readonly Auth[];

export const AUTH_LABEL = {
  none: 'no sign-in',
  proxy: 'sign-in required',
} as const satisfies Record<Auth, string>;

/** Adapters are registered at runtime, so readers fall back to the id. */
export const ADAPTER_LABEL: Record<string, string> = {
  kubernetes: 'Kubernetes',
  cloudrun: 'Cloud Run',
  static: 'Static hosting',
  vercel: 'Vercel',
  'cloudflare-pages': 'Cloudflare Pages',
};

/** The vessel the chosen Target decides, fixed once the App is created. */
export function VesselNote({
  name,
  note,
  ready,
}: {
  name: string;
  note: string;
  ready: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border-soft pt-3 text-xs text-muted-foreground">
      <span>
        Runs in <span className="font-mono text-foreground">{name}</span>.{' '}
        {note}
      </span>
      <Badge tone={ready ? 'idle' : 'destructive'}>
        <Lock aria-hidden="true" className="size-3" />
        {ready ? 'fixed once the App is created' : 'not provisioned'}
      </Badge>
    </div>
  );
}

export { Eyebrow };
