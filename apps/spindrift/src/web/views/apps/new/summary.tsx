/**
 * The plan, as rows that are already answered.
 *
 * Four rows — Code, Type, Name, Where it runs — each **label, the answer, why,
 * and an Edit that opens the correction in place**, because the whole claim of
 * this screen is that reading down it is enough. A row that needed a different
 * reading strategy would be a row that broke the claim.
 *
 * Corrections are disclosures rather than screens (story 32). A developer who
 * wants to change the kind should not lose sight of the Target that choice
 * decides, which is exactly what a five-step rail cost.
 *
 * The vocabulary on those four top lines is the reader's, not the platform's:
 * `KIND_LABEL`, `REACH_LABEL`, `AUTH_LABEL` and `ADAPTER_LABEL` are what a row
 * *states*, and the `*_NOTE` maps below are what a tile somebody is choosing
 * between *explains*. Those are two different jobs and they were one map.
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

/**
 * One decided row.
 *
 * `why` is not decoration. Every value on this screen was chosen by something
 * other than the person reading it, and a default with no stated reason is
 * indistinguishable from a value somebody typed and forgot.
 *
 * **Open-ness belongs to the parent.** Each row used to own three pieces of
 * sticky state — a `useState<boolean | null>`, a ref for "was ever unsettled",
 * a ref for "was unsettled last render" — and derive its own openness from an
 * `unsettled` prop fed by asynchronous reads. Rows opened themselves when a
 * `listTargets` refetch answered, several hundred pixels appeared under the
 * reader's cursor, and everything below jumped. Worse, two rows could decide
 * to open at once and neither knew about the other.
 *
 * One `expanded` value in the parent replaces all of it: one row is open at a
 * time, it opens because a person pressed Edit or because that row is the one
 * holding an unmet prerequisite, and it never changes under a read landing.
 */
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
  /** Whether the correction is showing. Owned by the parent. */
  open?: boolean;
  onToggle?: () => void;
  /**
   * What stands between this row and a Deploy.
   *
   * Rendered here rather than in a stack at the foot of the page. A sentence
   * saying "pick a Target that can run this" is unreadable eight sections away
   * from the Targets; beside the row it is about, it is the caption of the
   * thing it is complaining about.
   */
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

/**
 * One unmet prerequisite, where the thing it is about is.
 *
 * The markup is what the foot-of-page stack used to render, unchanged — what
 * moved is where it appears, not how loudly it says it.
 */
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
 * A selectable tile — the one affordance every correction chooses with.
 *
 * §3's grammar lives here: an option that does not apply stays **on screen,
 * disabled, wearing its reason**. That is what makes "that is not what this
 * is" a correction somebody makes by reading rather than by guessing, and it
 * is why this takes `children` as well as a note — the Target rows need more
 * room and must not drift into their own styling.
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

/**
 * Derived from the note map rather than listed again, so a fourth
 * {@link ComponentKind} is a compile error here instead of a tile that silently
 * never renders.
 */
export const KINDS = Object.keys(KIND_NOTE) as readonly ComponentKind[];

/**
 * What each value is called on the top line of a row.
 *
 * The notes below are definitions and belong beside a tile somebody is
 * choosing between. A row's *value* is read by somebody who is not choosing
 * anything, and `service` is jargon there — it is the platform's word for the
 * thing, not the reader's. `satisfies` over the domain union for the reason
 * {@link KINDS} is derived: a fourth kind is a compile error, not a blank.
 */
export const KIND_LABEL = {
  // Not "Web service": KIND_NOTE says a worker is a service that is not
  // exposed, and at `reach: none` that is exactly what this is.
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

/** Derived, for the same reason {@link KINDS} is. */
export const REACHES = Object.keys(REACH_NOTE) as readonly Reach[];

/** Reach as a person would say it. See {@link KIND_LABEL}. */
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

/** Derived, for the same reason {@link KINDS} is. */
export const AUTHS = Object.keys(AUTH_NOTE) as readonly Auth[];

/** Auth as a person would say it. See {@link KIND_LABEL}. */
export const AUTH_LABEL = {
  none: 'no sign-in',
  proxy: 'sign-in required',
} as const satisfies Record<Auth, string>;

/**
 * An adapter's product name, where it has one nobody has to learn.
 *
 * A plain `Record<string, string>` read through `?? adapter` rather than a
 * `satisfies` over a union, because `TargetOptionView.adapter` is typed
 * `string` — adapters are registered, not enumerated in the type system, so an
 * unknown one must render its own id rather than nothing.
 */
export const ADAPTER_LABEL: Record<string, string> = {
  kubernetes: 'Kubernetes',
  cloudrun: 'Cloud Run',
  static: 'Static hosting',
  vercel: 'Vercel',
  'cloudflare-pages': 'Cloudflare Pages',
};

/**
 * The vessel, which is a fact rather than a decision — but only after this
 * screen.
 *
 * Not a row of its own any more. A row is a thing with a correction behind an
 * Edit, and this one never had one: it stated a value and offered nothing to do
 * about it, which made it a row that punished you for reading it. It says the
 * same sentence at the foot of "Where it runs", beside the Target that decides
 * it, and it keeps its lock because the one moment it is still changeable is
 * the one moment saying so is useful.
 */
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
