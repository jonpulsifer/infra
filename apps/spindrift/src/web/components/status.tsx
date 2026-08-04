/**
 * The status atoms that carry domain meaning rather than styling.
 *
 * Each one exists because §6 or §18 named the thing it renders. They are here
 * and not in `ui/` for that reason: `ui/` holds primitives that would look the
 * same in any product, and these would not — a `BlameChip` is meaningless
 * outside a system that decided blame is derived, closed, and worth a chip.
 */
import { Check, CircleDashed, Loader2, X } from 'lucide-react';
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

/**
 * Everything a step status renders as, in one row per status.
 *
 * Four parallel maps keyed by the same union is four chances to add a status
 * to three of them. One record makes a missing field a compile error, which is
 * the same discipline `BLAME` and `KINDS_BY_ADAPTER` use in the domain — and
 * `waiting` is the row that proves it earns its keep: it is the only status
 * whose glyph, tone, and word all disagree with its key.
 *
 * `spin` is a claim about the system, not decoration. It is set on exactly the
 * status that means work is happening right now, so a stopped spinner is a
 * statement that nothing is moving — which is what makes the moving one
 * trustworthy. A step whose backend went silent still reads `running` and still
 * spins, and that is correct: the phase is what the platform last said, and the
 * screen does not get to decide it has gone stale.
 */
const STATUS = {
  done: { icon: Check, tone: 'text-success', word: 'done', spin: false },
  running: {
    icon: Loader2,
    tone: 'text-warning',
    word: 'running',
    spin: true,
  },
  failed: { icon: X, tone: 'text-destructive', word: 'failed', spin: false },
  waiting: {
    icon: CircleDashed,
    tone: 'text-muted-foreground',
    word: 'queued',
    spin: false,
  },
} as const satisfies Record<
  StepStatus,
  { icon: typeof Check; tone: string; word: string; spin: boolean }
>;

/** The leading glyph on a checklist line. */
export function StepGlyph({ status }: { status: StepStatus }) {
  const { icon: Icon, tone, spin } = STATUS[status];
  return (
    <Icon
      aria-hidden="true"
      className={cn('size-3.5 shrink-0', tone, spin && 'animate-spin')}
    />
  );
}

/** The word a step status reads as, where one is written out. */
export function statusWord(status: StepStatus): string {
  return STATUS[status].word;
}
