/**
 * The draft's write side: a trailing debounce in front of a serialized chain.
 * Saves go one at a time, because each one bumps the revision the next carries.
 */

export interface DraftWrites<Draft> {
  /** The newest edit wins, and nothing is sent while edits keep arriving. */
  edit(draft: Draft): void;
  /** Sends what is scheduled now and resolves once the chain drains. */
  flush(): Promise<void>;
  /**
   * Drops every unsent edit, for when the server's draft replaces the one on
   * screen. The server checks only the revision, so an older edit would be written.
   */
  discard(): void;
}

/** Milliseconds: swallows a burst of typing and still feels immediate. */
export const WRITE_DELAY = 350;

export function draftWrites<Draft>({
  save,
  onWriting,
  delay = WRITE_DELAY,
}: {
  save: (draft: Draft) => Promise<void>;
  /** Called `true` when a save leaves and `false` when the chain drains. */
  onWriting?: (writing: boolean) => void;
  delay?: number;
}): DraftWrites<Draft> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let scheduled: { draft: Draft } | null = null;
  let chain = Promise.resolve();
  let inFlight = 0;
  /** Bumped by `discard`; a queued save from an older run resolves unsent. */
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
    onWriting?.(true);
    const settle = () => {
      inFlight -= 1;
      if (inFlight === 0) onWriting?.(false);
    };
    // Settles on rejection too, so one failed save cannot stop every later one.
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
