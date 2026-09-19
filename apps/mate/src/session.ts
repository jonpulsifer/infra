import { unlink } from 'node:fs/promises';
import type { SessionInfo } from '@discordjs/ws';
import type { Log } from './log.ts';

export interface SessionStore {
  retrieve(shardId: number): Promise<SessionInfo | null>;
  update(shardId: number, info: SessionInfo | null): Promise<void>;
}

const WRITE_DEBOUNCE_MS = 1_000;

/**
 * Session info lands in a file so a container restart inside the same pod
 * resumes instead of spending an identify. The library updates the sequence
 * on every dispatch, so writes are debounced; a `null` (session invalidated)
 * removes the file at once.
 */
export function fileSessionStore(path: string, log: Log): SessionStore {
  let current: SessionInfo | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function flush(): Promise<void> {
    timer = null;
    try {
      await Bun.write(path, JSON.stringify(current));
    } catch (error) {
      log.warn('session file write failed', { path, error: String(error) });
    }
  }

  return {
    async retrieve() {
      if (current) return current;
      try {
        const file = Bun.file(path);
        if (!(await file.exists())) return null;
        current = (await file.json()) as SessionInfo | null;
        return current;
      } catch (error) {
        log.warn('session file unreadable; identifying fresh', {
          path,
          error: String(error),
        });
        return null;
      }
    },
    async update(_shardId, info) {
      current = info;
      if (info === null) {
        if (timer) clearTimeout(timer);
        timer = null;
        await unlink(path).catch(() => {});
        return;
      }
      if (!timer) timer = setTimeout(() => void flush(), WRITE_DEBOUNCE_MS);
    },
  };
}

export function memorySessionStore(): SessionStore {
  let current: SessionInfo | null = null;
  return {
    retrieve: async () => current,
    update: async (_shardId, info) => {
      current = info;
    },
  };
}
