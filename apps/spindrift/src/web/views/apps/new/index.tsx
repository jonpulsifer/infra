/**
 * The creation flow (Task 38, §18).
 *
 * Five explicit decisions, one at a time, with the recommendation already
 * selected before the developer sees it — Source → Component → Place →
 * Configure → Review. The rail is navigable in both directions because a
 * developer who wants to correct step two from step four should not have to
 * re-decide step three on the way back.
 *
 * The preflight is **folded into Review** rather than standing as a sixth step
 * (§18). A step whose only content is "everything is fine" trains people to
 * click past it, and the one time it says otherwise is the one time that
 * matters.
 */
import { type Dispatch, useReducer, useState } from 'react';
import { command, type TransportFailure } from '../../../client.ts';
import type { RepositoryOptionView, TargetOptionView } from '../../../model.ts';
import { Button } from '../../../ui/button.tsx';
import { Card, Eyebrow } from '../../../ui/card.tsx';
import { cn } from '../../../ui/utils.ts';
import {
  blockersFor,
  createAppInputFor,
  type Draft,
  draftReducer,
  STEPS,
} from './draft.ts';
import {
  Ledger,
  StepComponent,
  StepConfigure,
  StepPlace,
  StepReview,
  StepSource,
} from './steps.tsx';

export function NewApp({
  initialDraft,
  targets,
  repos,
}: {
  initialDraft: Draft;
  targets: readonly TargetOptionView[];
  repos: readonly RepositoryOptionView[];
}) {
  const [draft, dispatch] = useReducer(draftReducer, initialDraft);
  const [refusal, setRefusal] = useState<TransportFailure | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const candidateIds = targets
    .filter((target) => target.candidate)
    .map((target) => target.targetId);
  const blockers = blockersFor(draft, candidateIds);
  const last = draft.step === STEPS.length - 1;

  /**
   * Review's terminal act: create the App (§21's `createApp`), which locks its
   * vessel and — once Task 19 lands the Component and Build commands — starts
   * the first Build.
   *
   * Today this reaches a real endpoint and comes back `UNAUTHENTICATED`,
   * because nobody can sign in until Task 37. That is deliberately not hidden
   * behind a disabled button: a refusal the developer can read is the honest
   * state of the system, and wiring the call now is what proves the typed
   * client and the generated dispatch surface actually join up.
   */
  async function start() {
    setSubmitting(true);
    setRefusal(null);
    const result = await command('createApp', createAppInputFor(draft));
    if (!result.ok) setRefusal(result.failure);
    setSubmitting(false);
  }

  return (
    <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-5 px-5 py-6">
      <header>
        <Eyebrow>New App</Eyebrow>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          Deploy a new app
        </h1>
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">
          Five decisions, one at a time. Every one of them already has an answer
          — read down, correct what is wrong, and start the first Build.
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <Card className="flex flex-col">
          <nav
            aria-label="Creation steps"
            className="flex overflow-x-auto border-b border-border"
          >
            {STEPS.map((label, index) => (
              <button
                key={label}
                type="button"
                aria-current={draft.step === index ? 'step' : undefined}
                onClick={() => dispatch({ type: 'step', step: index })}
                className={cn(
                  'flex min-w-[110px] flex-1 flex-col gap-1 border-r border-border px-4 py-3 text-left last:border-r-0',
                  draft.step === index
                    ? 'bg-secondary shadow-[inset_0_-2px_0_var(--color-primary)]'
                    : 'hover:bg-secondary/60',
                )}
              >
                <Eyebrow>0{index + 1}</Eyebrow>
                <span className="text-sm font-semibold">{label}</span>
              </button>
            ))}
          </nav>

          <div className="flex-1 px-5 py-5">
            <StepBody
              draft={draft}
              dispatch={dispatch}
              targets={targets}
              blockers={blockers}
              repos={repos}
            />
            {refusal ? <Refusal failure={refusal} /> : null}
          </div>

          <footer className="flex items-center gap-2 border-t border-border px-5 py-3">
            <Button
              variant="ghost"
              disabled={draft.step === 0}
              onClick={() => dispatch({ type: 'step', step: draft.step - 1 })}
            >
              Back
            </Button>
            <div className="ml-auto">
              {last ? (
                <Button
                  disabled={blockers.length > 0 || submitting}
                  onClick={start}
                >
                  {submitting ? 'Creating…' : 'Start first Build'}
                </Button>
              ) : (
                <Button
                  onClick={() =>
                    dispatch({ type: 'step', step: draft.step + 1 })
                  }
                >
                  Continue
                </Button>
              )}
            </div>
          </footer>
        </Card>

        <aside className="flex flex-col gap-4">
          <Ledger draft={draft} targets={targets} />
        </aside>
      </div>
    </div>
  );
}

/**
 * What the server said when it would not do it.
 *
 * The code is shown alongside the sentence because it is a closed vocabulary
 * (`TransportFailureCode`) and therefore searchable — the same reason §6 keeps
 * its eight failure reasons rather than writing friendlier prose. `issues`
 * arrive when a schema refused, and each one names the field it refused.
 */
function Refusal({ failure }: { failure: TransportFailure }) {
  return (
    <div className="mt-4 rounded-md border border-destructive bg-destructive-soft px-3 py-2.5">
      <p className="font-mono text-xs font-semibold text-destructive">
        {failure.code}
      </p>
      <p className="mt-0.5 text-sm text-subtle">{failure.message}</p>
      {failure.issues?.length ? (
        <ul className="mt-1.5 flex flex-col gap-0.5">
          {failure.issues.map((issue) => (
            <li key={issue.path} className="font-mono text-xs text-subtle">
              {issue.path}: {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function StepBody({
  draft,
  dispatch,
  targets,
  blockers,
  repos,
}: {
  draft: Draft;
  dispatch: Dispatch<Parameters<typeof draftReducer>[1]>;
  targets: readonly TargetOptionView[];
  blockers: ReturnType<typeof blockersFor>;
  repos: readonly RepositoryOptionView[];
}) {
  switch (draft.step) {
    case 0:
      return <StepSource draft={draft} dispatch={dispatch} repos={repos} />;
    case 1:
      return <StepComponent draft={draft} dispatch={dispatch} />;
    case 2:
      return <StepPlace draft={draft} dispatch={dispatch} targets={targets} />;
    case 3:
      return <StepConfigure draft={draft} dispatch={dispatch} />;
    default:
      return <StepReview draft={draft} targets={targets} blockers={blockers} />;
  }
}
