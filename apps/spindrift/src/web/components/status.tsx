/**
 * The status atoms that carry domain meaning rather than styling.
 *
 * Each one exists because §6 or §18 named the thing it renders. They are here
 * and not in `ui/` for that reason: `ui/` holds primitives that would look the
 * same in any product, and these would not — a `BlameChip` is meaningless
 * outside a system that decided blame is derived, closed, and worth a chip.
 */
import { Check, CircleDashed, Dot as DotIcon, X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Blame } from '../../adapters/deploy/contract.ts';
import { type DeployPhase, isInFlight, type StepStatus } from '../model.ts';
import { Badge, Dot } from '../ui/badge.tsx';
import { cn } from '../ui/utils.ts';

/** The tone each phase reads in. `LIVE` is the only green state there is. */
function toneFor(phase: DeployPhase) {
  if (phase === 'LIVE') return 'success' as const;
  if (phase === 'FAILED') return 'destructive' as const;
  return 'warning' as const;
}

/**
 * The phase marker: a tone, a word, and a dot that pulses only while the phase
 * is still moving.
 */
export function PhasePill({
  phase,
  children,
}: {
  phase: DeployPhase;
  children: ReactNode;
}) {
  return (
    <Badge tone={toneFor(phase)}>
      <Dot pulse={isInFlight(phase)} />
      {children}
    </Badge>
  );
}

/**
 * §18: "`blame` earns its chip."
 *
 * It is justified hardest by `ARTIFACT_UNAVAILABLE`, where the build is green
 * and every instinct wrongly says "look at my app" — so the chip is what stops
 * a developer debugging code that is fine. A `null` blame renders nothing at
 * all rather than a third word: §6 gives `TIMEOUT` a dash because a deploy that
 * never reached a terminal state indicts nobody, and printing "unknown" would
 * be a guess the table refused to make.
 */
export function BlameChip({ blame }: { blame: Blame | null }) {
  if (blame === null) return null;
  return (
    <span
      className={cn(
        'rounded-sm border px-1.5 py-1',
        'text-[10.5px] font-semibold uppercase leading-none tracking-[0.07em]',
        blame === 'developer' ? 'text-warning' : 'text-accent-foreground',
      )}
    >
      {blame}
    </span>
  );
}

const GLYPH = {
  done: Check,
  running: DotIcon,
  failed: X,
  waiting: CircleDashed,
} as const satisfies Record<StepStatus, typeof Check>;

const GLYPH_TONE = {
  done: 'text-success',
  running: 'text-warning',
  failed: 'text-destructive',
  waiting: 'text-muted-foreground',
} as const satisfies Record<StepStatus, string>;

/** The leading glyph on a checklist line. */
export function StepGlyph({ status }: { status: StepStatus }) {
  const Icon = GLYPH[status];
  return (
    <Icon
      aria-hidden="true"
      className={cn('size-3.5 shrink-0', GLYPH_TONE[status])}
    />
  );
}

/** The word a step status reads as, where one is written out. */
export function statusWord(status: StepStatus): string {
  return {
    done: 'done',
    running: 'running',
    failed: 'failed',
    waiting: 'queued',
  }[status];
}
