/**
 * Where an attempt has got to, as one strip across the top of the screen.
 *
 * §18 rejects the stage rail every CI tool reaches for, and this is not that
 * rail: it does not *structure* the page, it summarises it. The order down the
 * screen is still state, diagnosis, what the release is, resources, logs — the
 * running App first and the pipeline second. What this adds is the one thing
 * that order cannot carry on its own, which is **how far along**. A reader who
 * arrives mid-deploy should not have to infer that from which drawers happen to
 * be open.
 *
 * It earns its place by being a legend rather than a navigation surface:
 * nothing here is clickable, every segment names its own state in words, and
 * the whole thing collapses to a single line once the release is live. A strip
 * you can press would be a rail again.
 *
 * **The bar is honest about not knowing.** A deploy has no percentage — the
 * platform reports phases, not fractions — so the fill is derived from *stages
 * settled*, and the stage in flight contributes a half rather than a guess. The
 * sweep across the fill is what says "moving, duration unknown"; a bar that
 * crept toward 90% and waited there would be inventing a number the controller
 * never gave.
 */
import type { StepStatus } from '../../commands/views.ts';
import { cn } from '../ui/utils.ts';
import { StepGlyph, statusWord } from './status.tsx';

/** One leg of the journey from source to serving. */
export interface Stage {
  readonly name: string;
  readonly status: StepStatus;
  /** The platform's own word for what this leg is doing, when it has one. */
  readonly detail?: string;
}

/**
 * How full the bar is.
 *
 * A settled stage counts whole and a running one counts half, so the bar moves
 * on real transitions and never on a timer. Everything after a failure stays
 * unfilled: a red deploy has not quietly made progress on the legs behind it.
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

/** The tone the whole strip reads in: red beats moving, moving beats green. */
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
      // One label for the whole strip. Each segment repeats its state in words
      // below, so a screen reader that walks the list gets the detail; this is
      // the summary somebody arriving on the region hears first.
      role="group"
      aria-label={`Progress: ${stages
        .map((stage) => `${stage.name} ${statusWord(stage.status)}`)
        .join(', ')}`}
    >
      <div className="h-1 w-full overflow-hidden rounded-full bg-secondary">
        <div
          className={cn(
            'relative h-full overflow-hidden rounded-full',
            // `width` rather than `scaleX`: the fill is `rounded-full`, and a
            // scaled box takes its rounded cap with it, so the leading edge
            // would flatten as the bar grew. One element transitioning five
            // times across a deploy is a trade worth making for a cap that
            // stays a cap.
            'transition-[width] duration-700 ease-out',
            FILL[tone],
            // Only the moving bar moves. A settled one holding a sweep would
            // say something is happening when nothing is.
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
