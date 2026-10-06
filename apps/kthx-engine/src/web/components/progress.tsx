/**
 * How far an attempt has got, as one strip nothing can press. A deploy reports
 * phases and no percentage, so the fill counts settled stages and the sweep says
 * the running stage has no known duration.
 */
import type { StepStatus } from '../../commands/views.ts';
import { cn } from '../ui/utils.ts';
import { StepGlyph, statusWord } from './status.tsx';

export interface Stage {
  readonly name: string;
  readonly status: StepStatus;
  /** The platform's own word for what this leg is doing, when it has one. */
  readonly detail?: string;
}

/**
 * A settled stage counts whole and a running one half, so the bar moves only on
 * real transitions. Nothing after a failure fills.
 */
function fractionOf(stages: readonly Stage[]): number {
  if (stages.length === 0) return 0;
  let filled = 0;
  for (const stage of stages) {
    if (stage.status === 'failed') break;
    if (stage.status === 'done') filled += 1;
    else if (stage.status === 'running') {
      filled += 0.5;
      break;
    } else break;
  }
  return filled / stages.length;
}

function toneOf(stages: readonly Stage[]): 'failed' | 'running' | 'done' {
  if (stages.some((stage) => stage.status === 'failed')) return 'failed';
  if (stages.some((stage) => stage.status === 'running')) return 'running';
  return 'done';
}

const FILL = {
  failed: 'bg-destructive',
  running: 'bg-warning',
  done: 'bg-success',
} as const;

export function StageProgress({
  stages,
  className,
}: {
  stages: readonly Stage[];
  className?: string;
}) {
  if (stages.length === 0) return null;
  const tone = toneOf(stages);
  const percent = Math.round(fractionOf(stages) * 100);

  return (
    <div
      className={cn('flex flex-col gap-2', className)}
      // The summary; each segment below also states itself in words.
      role="group"
      aria-label={`Progress: ${stages
        .map((stage) => `${stage.name} ${statusWord(stage.status)}`)
        .join(', ')}`}
    >
      <div className="h-1 w-full overflow-hidden rounded-full bg-secondary">
        <div
          className={cn(
            'relative h-full overflow-hidden rounded-full',
            // `width`, since `scaleX` would squash the rounded leading cap.
            'transition-[width] duration-700 ease-out',
            FILL[tone],
            tone === 'running' &&
              cn(
                'after:absolute after:inset-0 after:bg-[image:var(--shimmer)]',
                'motion-safe:after:animate-shimmer',
              ),
          )}
          style={{ width: `${percent}%` }}
        />
      </div>

      <ol className="flex flex-wrap items-start gap-x-1 gap-y-2">
        {stages.map((stage, index) => (
          <li key={stage.name} className="flex items-start gap-1">
            <div className="flex flex-col gap-0.5">
              <span className="flex items-center gap-1.5">
                <StepGlyph status={stage.status} />
                <span
                  className={cn(
                    'text-[12.5px] font-medium',
                    stage.status === 'waiting'
                      ? 'text-muted-foreground'
                      : 'text-foreground',
                  )}
                >
                  {stage.name}
                </span>
              </span>
              <span
                className="pl-[22px] text-[11px] text-muted-foreground"
                title={stage.detail}
              >
                {stage.detail ?? statusWord(stage.status)}
              </span>
            </div>
            {index < stages.length - 1 ? (
              <span
                aria-hidden="true"
                className="mt-[7px] ml-1 mr-1 h-px w-6 shrink-0 bg-border sm:w-10"
              />
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
