/** Status atoms that carry domain meaning, kept apart from the generic `ui/`. */
import { Check, CircleDashed, Loader2, X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Blame } from '../../adapters/deploy/contract.ts';
import {
  type DeployPhase,
  deployPhaseWord,
  isInFlight,
  type StepStatus,
} from '../../commands/views.ts';
import { Badge, Dot } from '../ui/badge.tsx';
import { cn } from '../ui/utils.ts';

/**
 * `LIVE` is the only green phase, and a faulty release loses it.
 * {@link appDotTone} reads this too, so the two never disagree.
 */
export function toneFor(phase: DeployPhase, faulty: boolean) {
  if (faulty || phase === 'FAILED') return 'destructive' as const;
  if (phase === 'LIVE') return 'success' as const;
  return 'warning' as const;
}

// A bare dot takes its fill from the text colour.
const DOT = {
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
} as const satisfies Record<ReturnType<typeof toneFor>, string>;

/** For the topology boxes, too narrow for a word; screen readers get it. */
export function PhaseDot({
  phase,
  faulty = false,
}: {
  phase: DeployPhase;
  faulty?: boolean;
}) {
  const word = faulty ? 'Faulty' : deployPhaseWord(phase);
  return (
    <span
      className={cn('inline-flex items-center', DOT[toneFor(phase, faulty)])}
    >
      <Dot pulse={isInFlight(phase)} title={word} />
      <span className="sr-only">{word}</span>
    </span>
  );
}

export type AppDotTone = 'live' | 'building' | 'failed' | 'idle';

const APP_DOT_TONE: Record<AppDotTone, string> = {
  live: 'text-status-live',
  building: 'text-status-building',
  failed: 'text-status-failed',
  idle: 'text-status-idle',
};

/**
 * A never-deployed App reports `PENDING` with no `deployId`, which `toneFor`
 * would read as building, so idle is checked first.
 */
export function appDotTone(app: {
  readonly phase: DeployPhase;
  readonly faulty?: boolean;
  readonly deployId?: number;
}): AppDotTone {
  if (app.deployId === undefined && app.phase === 'PENDING') return 'idle';
  const tone = toneFor(app.phase, app.faulty ?? false);
  if (tone === 'success') return 'live';
  if (tone === 'destructive') return 'failed';
  return 'building';
}

/** Hidden from screen readers, since the row's label states the status. */
export function AppDot({
  app,
  className,
}: {
  readonly app: Parameters<typeof appDotTone>[0];
  readonly className?: string;
}) {
  const tone = appDotTone(app);
  return (
    <Dot
      aria-hidden="true"
      pulse={tone === 'building'}
      hollow={tone === 'idle'}
      className={cn(APP_DOT_TONE[tone], className)}
    />
  );
}

/**
 * `children` replaces the phase word where a phase alone says too little.
 * `faulty` is the soak's verdict on a `LIVE` release.
 */
export function PhasePill({
  phase,
  faulty = false,
  children,
}: {
  phase: DeployPhase;
  faulty?: boolean;
  children?: ReactNode;
}) {
  return (
    <Badge tone={toneFor(phase, faulty)}>
      <Dot pulse={isInFlight(phase)} />
      {children ?? (faulty ? 'Faulty' : deployPhaseWord(phase))}
    </Badge>
  );
}

/** A `null` blame renders nothing: an undecided failure indicts nobody. */
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

// One record per status, so a status missing any field fails to compile.
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

/**
 * `done` draws its tick once, on mount. `pathLength={1}` normalises every path,
 * so one dash keyframe covers any icon's stroke.
 */
export function StepGlyph({ status }: { status: StepStatus }) {
  const { icon: Icon, tone, spin } = STATUS[status];
  return (
    <Icon
      aria-hidden="true"
      pathLength={status === 'done' ? 1 : undefined}
      className={cn(
        'size-3.5 shrink-0',
        tone,
        spin && 'animate-spin',
        status === 'done' &&
          'motion-safe:[&_*]:[stroke-dasharray:1] motion-safe:[&_*]:animate-draw',
      )}
    />
  );
}

export function statusWord(status: StepStatus): string {
  return STATUS[status].word;
}
