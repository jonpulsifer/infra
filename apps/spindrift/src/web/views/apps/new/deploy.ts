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
 *
 * Which is why the outcomes are five rather than three. Two of the ways the
 * press can end are not refusals to report: a stale revision is the same
 * recoverable state a refused save is, and a completion that never answered is
 * not the server saying no — it is nobody knowing what it did.
 */
import type {
  ClientResult,
  OutputOf,
  TransportFailure,
} from '../../../client.ts';

type Completion = OutputOf<'completeCreationDraft'>;

/** Said when Deploy is refused by a save nobody watched fail. */
export const UNSAVED_TITLE = 'Nothing was created — this draft is not saved';

/** Said when the completing command never answered at all. */
export const LOST_TITLE = 'Spindrift did not hear back';

export type DeployOutcome =
  /** The draft never reached the server, so nothing was completed. */
  | {
      readonly act: 'unsaved';
      readonly failure: TransportFailure;
      readonly title: string;
    }
  /**
   * The draft moved under this tab, so completing it is the same recovery a
   * refused save is: the revision this tab holds is a version that no longer
   * exists, and pressing again sends it again. Its own arm because it is the
   * one refusal the screen can answer rather than report.
   */
  | { readonly act: 'stale' }
  /** The completing command itself refused. */
  | { readonly act: 'refused'; readonly failure: TransportFailure }
  /**
   * It was sent and nothing came back — a dropped connection, or a proxy
   * answering with its own error page. Distinct from a refusal because the
   * server may well have created the App: the only honest thing to say is that
   * this is unknown, which a button stuck on "Creating…" does not say.
   */
  | {
      readonly act: 'lost';
      readonly failure: TransportFailure;
      readonly title: string;
    }
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
