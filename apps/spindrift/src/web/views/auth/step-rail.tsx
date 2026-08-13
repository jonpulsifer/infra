/**
 * The four questions, all of them, while only one is being answered.
 *
 * A wizard's progress was the sentence `Step 2 of 4`, which says how much is
 * left and nothing about what it is. `ONBOARDING_ASKS` has carried a title for
 * each of the four since the day it was written — including the reason the
 * order is what it is — and an operator met each one only on arrival, so the
 * step that reads the cloud, and can therefore refuse, was always a surprise.
 *
 * **It is a rail, not a tab bar.** A step behind the current one is a button,
 * because an answer already given is an answer worth revising and the document
 * is one object held above this. A step ahead is text: the order is load
 * bearing — the third step needs a stored client id to be worth anything, and
 * the last is the write — so jumping forward is an act this flow does not have.
 *
 * **A finished step shows its answer, so the rail is also the summary.** That
 * is what earns the space it takes and is why there is no fifth "Review" step:
 * the four answers are legible from every step, which is the whole of what a
 * review screen would have added, and a fifth screen would have moved the one
 * write off the last question and onto a page of its own.
 *
 * It states no status of its own — {@link StepStatus} and its glyph come from
 * `components/status.tsx`, the same pair every checklist in the product uses,
 * so a wizard step and a deploy step do not read as two different vocabularies.
 */

import type { StepStatus } from '../../../commands/views.ts';
import { StepGlyph, statusWord } from '../../components/status.tsx';
import { cn } from '../../ui/utils.ts';

export interface RailStep {
  readonly title: string;
  /** The answer, when there is one to show. Truncated, in mono. */
  readonly value?: string;
  readonly status: StepStatus;
}

export function StepRail({
  steps,
  current,
  onJump,
}: {
  readonly steps: readonly RailStep[];
  readonly current: number;
  /** Absent means nothing is navigable — the rail is then pure progress. */
  onJump?(step: number): void;
}) {
  return (
    <ol aria-label="Setup steps" className="flex flex-col gap-0.5">
      {steps.map((step, index) => {
        const here = index === current;
        const behind = index < current;
        const body = (
          <>
            <StepGlyph status={step.status} />
            <span className="min-w-0 flex-1">
              <span
                className={cn(
                  'block truncate text-body',
                  here
                    ? 'font-semibold text-foreground'
                    : 'text-muted-foreground',
                )}
              >
                {step.title}
              </span>
              {step.value === undefined || step.value === '' ? null : (
                <span className="block truncate font-mono text-micro text-subtle">
                  {step.value}
                </span>
              )}
            </span>
            <span className="sr-only">{statusWord(step.status)}</span>
          </>
        );

        return (
          <li key={step.title}>
            {behind && onJump !== undefined ? (
              <button
                type="button"
                onClick={() => onJump(index)}
                className={cn(
                  'flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left',
                  'hover:bg-secondary focus-visible:-outline-offset-2',
                )}
              >
                {body}
              </button>
            ) : (
              <div
                aria-current={here ? 'step' : undefined}
                className={cn(
                  'flex w-full items-start gap-2 rounded-sm px-2 py-1.5',
                  here && 'bg-secondary',
                )}
              >
                {body}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
