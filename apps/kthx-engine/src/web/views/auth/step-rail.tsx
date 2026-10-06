/**
 * The setup steps beside the current one. A step behind is a button and a step
 * ahead is text: the order matters, and the last step is the write.
 */

import type { CSSProperties } from 'react';
import type { StepStatus } from '../../../commands/views.ts';
import { StepGlyph, statusWord } from '../../components/status.tsx';
import { cn } from '../../ui/utils.ts';

export interface RailStep {
  readonly title: string;
  /** The answer, when there is one. */
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
  /** Absent makes every step plain text. */
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
                // Named on the current row only, so the highlight travels between
                // rows. Two elements with one name abort the transition.
                style={
                  here
                    ? ({ viewTransitionName: 'setup-step' } as CSSProperties)
                    : undefined
                }
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
