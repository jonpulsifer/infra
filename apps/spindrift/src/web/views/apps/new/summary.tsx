/**
 * The plan, as rows that are already answered.
 *
 * Each row is one of §18's five decisions and each one arrives decided. The
 * grammar is the same every time — **label, the answer, why, and an Edit that
 * opens the correction in place** — because the whole claim of this screen is
 * that reading down it is enough, and a row that needed a different reading
 * strategy would be a row that broke the claim.
 *
 * Corrections are disclosures rather than screens (story 32). A developer who
 * wants to change the kind should not lose sight of the Target that choice
 * decides, which is exactly what a five-step rail cost.
 */
import { ChevronRight, Lock, Pencil } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import type {
  Auth,
  ComponentKind,
  Reach,
} from '../../../../domain/desired-state.ts';
import { Badge, Dot } from '../../../ui/badge.tsx';
import { Button } from '../../../ui/button.tsx';
import { Eyebrow } from '../../../ui/card.tsx';
import { cn } from '../../../ui/utils.ts';

/**
 * One decided row.
 *
 * `why` is not decoration. Every value on this screen was chosen by something
 * other than the person reading it, and a default with no stated reason is
 * indistinguishable from a value somebody typed and forgot.
 */
export function Row({
  label,
  value,
  why,
  tone,
  unsettled = false,
  children,
}: {
  label: string;
  value: ReactNode;
  why?: ReactNode;
  /** Rendered beside the value — a health dot, a badge, an artifact type. */
  tone?: ReactNode;
  /**
   * Whether this row's answer is one somebody still has to make.
   *
   * An unsettled row opens itself, and that is load-bearing rather than
   * convenient. §3's disabled-with-reasons grammar only works if the
   * alternatives are *visible* — "nowhere fits" is unreadable when the list of
   * places that do not fit is behind a disclosure. Same rule §18 gives the
   * build log: collapsed on green, open on anything else.
   *
   * Toggling takes over from it, so a reader who closed a row keeps it closed.
   */
  unsettled?: boolean;
  /** The correction, if this row has one. Absent makes the row a fact. */
  children?: ReactNode;
}) {
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? unsettled;
  const setOpen = (next: (current: boolean) => boolean) =>
    setToggled(next(open));

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
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
          >
            {open ? (
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
      </div>
      {open && children ? (
        <div className="border-t border-border-soft bg-secondary/40 px-4 py-4">
          {children}
        </div>
      ) : null}
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

export const REACH_NOTE = {
  none: 'No route. Nothing resolves to it, and it has no address to share.',
  private:
    'An address on your own network. Not reachable from the internet, whatever is in front of it.',
  public:
    'An address the internet reaches. The default is to put nothing in front of it.',
} as const satisfies Record<Reach, string>;

/** Derived, for the same reason {@link KINDS} is. */
export const REACHES = Object.keys(REACH_NOTE) as readonly Reach[];

export const AUTH_NOTE = {
  none: 'Nothing authenticates in front of it. Whoever can reach it, can use it.',
  proxy:
    "The Target's own authenticated edge stands in front. Only where the Target offers one.",
} as const satisfies Record<Auth, string>;

/** Derived, for the same reason {@link KINDS} is. */
export const AUTHS = Object.keys(AUTH_NOTE) as readonly Auth[];

/**
 * The vessel, which is a fact rather than a decision — but only after this
 * screen.
 *
 * Stated with its lock because the one moment it is still changeable is the
 * one moment saying so is useful.
 */
export function VesselRow({
  name,
  note,
  ready,
}: {
  name: string;
  note: string;
  ready: boolean;
}) {
  return (
    <Row
      label="Vessel"
      value={name}
      tone={
        <Badge tone={ready ? 'idle' : 'destructive'}>
          <Lock aria-hidden="true" className="size-3" />
          {ready ? 'immutable once created' : 'not provisioned'}
        </Badge>
      }
      why={note}
    />
  );
}

/** A disclosure for the things nobody needs on the happy path. */
export function Advanced({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-border-soft last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="group flex w-full items-center gap-1.5 px-4 py-3 text-left text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn('size-3.5 transition-transform', open && 'rotate-90')}
        />
        {title}
      </button>
      {open ? <div className="px-4 pb-4">{children}</div> : null}
    </div>
  );
}

/** The live dot a Target wears in the summary. */
export function TargetHealth({ healthy }: { healthy: boolean }) {
  return (
    <Badge tone={healthy ? 'success' : 'destructive'}>
      <Dot />
      {healthy ? 'healthy' : 'not a candidate'}
    </Badge>
  );
}

export { Eyebrow };
