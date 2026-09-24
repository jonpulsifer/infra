/**
 * What pressing Deploy does. Deploy completes the draft the server holds, so
 * pending writes flush first, and a refused save sends nothing.
 */
import type {
  ClientResult,
  OutputOf,
  TransportFailure,
} from '../../../client.ts';

type Completion = OutputOf<'completeCreationDraft'>;

export const UNSAVED_TITLE = 'Nothing was created — this draft is not saved';

export const LOST_TITLE = 'Spindrift did not hear back';

export type DeployOutcome =
  /** The last save was refused, so nothing was sent. */
  | {
      readonly act: 'unsaved';
      readonly failure: TransportFailure;
      readonly title: string;
    }
  /** Another tab moved the draft, so the screen resyncs. */
  | { readonly act: 'stale' }
  | { readonly act: 'refused'; readonly failure: TransportFailure }
  /**
   * Sent with no answer, such as a dropped connection or a proxy's own error
   * page. The server may have created the App.
   */
  | {
      readonly act: 'lost';
      readonly failure: TransportFailure;
      readonly title: string;
    }
  /** The App in the result is null when the draft was blocked. */
  | { readonly act: 'completed'; readonly result: Completion };

export async function deployDraft(steps: {
  /** Sends what the debounce holds and waits for the write chain to drain. */
  flush(): Promise<void>;
  /** The last write's refusal, or null when it saved. */
  unsaved(): TransportFailure | null;
  complete(): Promise<ClientResult<Completion>>;
}): Promise<DeployOutcome> {
  await steps.flush();
  const failure = steps.unsaved();
  if (failure !== null) {
    return { act: 'unsaved', failure, title: UNSAVED_TITLE };
  }
  let result: ClientResult<Completion>;
  try {
    result = await steps.complete();
  } catch (cause) {
    return {
      act: 'lost',
      failure: {
        code: 'INTERNAL',
        message: `${cause instanceof Error ? cause.message : 'the request did not complete'} — nothing here knows whether the App was created. Check Apps before pressing Deploy again.`,
      },
      title: LOST_TITLE,
    };
  }
  if (result.ok) return { act: 'completed', result: result.value };
  return result.failure.code === 'STALE_EDIT'
    ? { act: 'stale' }
    : { act: 'refused', failure: result.failure };
}
