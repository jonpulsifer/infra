/**
 * What pressing Deploy does, in the order it has to happen.
 *
 * Separate from the screen for the reason `detect.ts` is: the interesting part
 * is a sequence with one rule in it, and the rule is invisible when it is four
 * lines inside a click handler.
 *
 * The rule is that **Deploy completes the draft the server holds, not the one
 * on screen**. So the writes are flushed first — a debounce means the last
 * edit may still be sitting in a timer — and then the question is whether they
 * landed. If they did not, nothing is sent: the revision would be right and the
 * document wrong, which produces an App built from an older answer with no sign
 * that anything was ignored.
 *
 * What went wrong before was smaller and worse. The screen cleared the refusal,
 * awaited the chain, and returned on failure — so a save that had been refused
 * while nobody was looking made Deploy a button that erased the only sentence
 * explaining itself and did nothing. The failure is the answer to the press,
 * and this returns it.
 */
import type {
  ClientResult,
  OutputOf,
  TransportFailure,
} from '../../../client.ts';

type Completion = OutputOf<'completeCreationDraft'>;

/** Said when Deploy is refused by a save nobody watched fail. */
export const UNSAVED_TITLE = 'Nothing was created — this draft is not saved';

export type DeployOutcome =
  /** The draft never reached the server, so nothing was completed. */
  | {
      readonly act: 'unsaved';
      readonly failure: TransportFailure;
      readonly title: string;
    }
  /** The completing command itself refused. */
  | { readonly act: 'refused'; readonly failure: TransportFailure }
  /** It ran. The App may still be null — a blocked draft creates nothing. */
  | { readonly act: 'completed'; readonly result: Completion };

export async function deployDraft(steps: {
  /** Send anything the debounce is holding and wait for the chain to drain. */
  flush(): Promise<void>;
  /** What the last write was refused with, once the chain has drained. */
  unsaved(): TransportFailure | null;
  complete(): Promise<ClientResult<Completion>>;
}): Promise<DeployOutcome> {
  await steps.flush();
  const failure = steps.unsaved();
  if (failure !== null) {
    return { act: 'unsaved', failure, title: UNSAVED_TITLE };
  }
  const result = await steps.complete();
  return result.ok
    ? { act: 'completed', result: result.value }
    : { act: 'refused', failure: result.failure };
}
