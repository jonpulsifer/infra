/**
 * The draft's write side: a trailing debounce in front of a serialized chain.
 *
 * The draft is server-owned and guarded by a revision, so **order is not
 * negotiable** — two saves in flight at once means the second carries a
 * revision the first is about to invalidate, and the loser is refused as a
 * stale edit the operator never made. That is what the chain is for, and it is
 * why the debounce sits in *front* of it rather than replacing it: coalescing
 * decides how many saves are sent, and the chain decides that they are sent one
 * at a time.
 *
 * What the debounce buys is the other half. Every keystroke in a name was one
 * round trip and one revision bump, so typing `almanac-staging` wrote sixteen
 * versions of a draft nobody had finished writing — and the button underneath
 * flipped disabled and back on every one of them.
 *
 * `save` owns its own refusals and must not reject; a rejection is still
 * absorbed here, because a chain that stays rejected is a draft that silently
 * never saves again.
 */

export interface DraftWrites<Draft> {
  /**
   * Record an edit. The newest one wins, and nothing is sent while edits keep
   * arriving.
   */
  edit(draft: Draft): void;
  /** Send whatever is scheduled now, and resolve once the chain has drained. */
  flush(): Promise<void>;
  /**
   * Drop every edit that has not reached the server yet.
   *
   * For the one case where sending them would be worse than losing them: the
   * draft on screen has been replaced by the server's, so an edit written
   * against the version before it is not a newer answer, it is an older
   * document about to be written at the newer revision — and it would land,
   * because the revision guard is all the server checks. Both the timer and
   * anything already queued behind the save in flight, since the save that
   * recovers is itself in that chain.
   */
  discard(): void;
}

/** Long enough to swallow a burst of typing, short enough to feel immediate. */
export const WRITE_DELAY = 350;

export function draftWrites<Draft>({
  save,
  onWriting,
  delay = WRITE_DELAY,
}: {
  save: (draft: Draft) => Promise<void>;
  /**
   * Called `true` when a save leaves and `false` when the chain drains.
   *
   * At the debounce boundary rather than per edit, which is what keeps Deploy
   * from flickering through a burst: while edits are only scheduled there is
   * nothing in flight to report, and pressing Deploy flushes them anyway.
   */
  onWriting: (writing: boolean) => void;
  delay?: number;
}): DraftWrites<Draft> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let scheduled: { draft: Draft } | null = null;
  let chain = Promise.resolve();
  let inFlight = 0;
  /**
   * Which run of edits the queue is on.
   *
   * A queued save is a closure the chain has already accepted, so `discard`
   * cannot reach into it — it moves the count instead, and a save whose count
   * has been left behind resolves without being sent.
   */
  let run = 0;

  const send = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (scheduled === null) return;
    const { draft } = scheduled;
    const sending = run;
    scheduled = null;
    inFlight += 1;
    onWriting(true);
    const settle = () => {
      inFlight -= 1;
      if (inFlight === 0) onWriting(false);
    };
    chain = chain
      .then(() => (sending === run ? save(draft) : undefined))
      .then(settle, settle);
  };

  return {
    edit(draft) {
      scheduled = { draft };
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(send, delay);
    },
    async flush() {
      send();
      await chain;
    },
    discard() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      scheduled = null;
      run += 1;
    },
  };
}
