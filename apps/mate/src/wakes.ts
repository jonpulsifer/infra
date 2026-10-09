/**
 * Wakes: a thread asks mate to continue it later, after some minutes or once
 * a pull request's GitHub Actions runs finish. `mate_wakes` holds one row a
 * thread, so a new wake replaces the pending one. A pull request is polled
 * here, with no model turn, until it settles or the deadline passes.
 */
import { Type } from '@earendil-works/pi-ai';
import type {
  ToolExecutionResult,
  ToolRegistration,
} from '@earendil-works/pi-durable';
import type { SQL } from 'bun';
import { type Clock, systemClock } from './clock.ts';
import { type Log, plain } from './log.ts';
import { type ThreadRef, threadKey } from './surface.ts';

export const WAKE_TOOL = 'wake';
export const WAKE_INTERVAL_MS = 60_000;
export const MIN_WAKE_MINUTES = 5;
export const MAX_WAKE_MINUTES = 24 * 60;
/** Heads every line mate posts about a wake. */
export const WAKE_MARK = '⏰';
// A head with no Actions run this long after the wake was set runs none: the
// CI routing lists paths, and an unlisted change starts nothing.
export const NO_RUNS_MS = 15 * 60_000;
const NOTE_LIMIT = 500;

const ATLANTIC = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Halifax',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function atlantic(ms: number): string {
  return `${ATLANTIC.format(ms)} Atlantic`;
}

export interface Wake {
  readonly key: string;
  readonly ref: ThreadRef;
  /** Whose turn set it; the woken turn runs as their reply. */
  readonly asker: string;
  readonly note: string;
  /** When a timed wake fires, and the deadline of a pull request wake. */
  readonly dueAt: number;
  readonly pr: number | null;
  readonly createdAt: number;
}

export interface WakeStore {
  /** Replaces the thread's pending wake. */
  put(wake: Wake): Promise<void>;
  list(): Promise<Wake[]>;
  /** Deletes the wake if it is still the one set at `createdAt`; true when it was. */
  take(key: string, createdAt: number): Promise<boolean>;
  /** True when there was one. */
  cancel(key: string): Promise<boolean>;
}

interface WakeRow {
  key: string;
  surface: string;
  channel_id: string;
  thread_id: string;
  asker: string;
  note: string;
  due_at: string | number;
  pr: number | null;
  created_at: string | number;
}

export class PostgresWakeStore implements WakeStore {
  constructor(private readonly sql: SQL) {}

  async put(wake: Wake): Promise<void> {
    const { key, ref, asker, note, dueAt, pr, createdAt } = wake;
    await this.sql`INSERT INTO mate_wakes
        (key, surface, channel_id, thread_id, asker, note, due_at, pr, created_at)
      VALUES (${key}, ${ref.surface}, ${ref.channelId}, ${ref.id}, ${asker},
        ${note}, ${dueAt}, ${pr}, ${createdAt})
      ON CONFLICT (key) DO UPDATE SET asker = EXCLUDED.asker,
        note = EXCLUDED.note, due_at = EXCLUDED.due_at, pr = EXCLUDED.pr,
        created_at = EXCLUDED.created_at`;
  }

  async list(): Promise<Wake[]> {
    const rows = (await this
      .sql`SELECT * FROM mate_wakes ORDER BY due_at`) as WakeRow[];
    return rows.map((row) => ({
      key: row.key,
      ref: {
        surface: row.surface as ThreadRef['surface'],
        channelId: row.channel_id,
        id: row.thread_id,
      },
      asker: row.asker,
      note: row.note,
      dueAt: Number(row.due_at),
      pr: row.pr,
      createdAt: Number(row.created_at),
    }));
  }

  async take(key: string, createdAt: number): Promise<boolean> {
    const rows = await this.sql`DELETE FROM mate_wakes
      WHERE key = ${key} AND created_at = ${createdAt} RETURNING key`;
    return rows.length > 0;
  }

  async cancel(key: string): Promise<boolean> {
    const rows = await this
      .sql`DELETE FROM mate_wakes WHERE key = ${key} RETURNING key`;
    return rows.length > 0;
  }
}

/** Where a pull request stands; `settled` once nothing is left to wait for. */
export interface PullState {
  readonly settled: boolean;
  readonly summary: string;
}

export interface PullRequests {
  /** `since` is when the wake was set. Throws when GitHub cannot answer. */
  state(pr: number, since: number): Promise<PullState>;
}

export interface RepoReader {
  /** A GET under the repository, such as `/pulls/1`, parsed as JSON. */
  read<T>(path: string): Promise<T>;
}

interface Pull {
  state?: string;
  merged?: boolean;
  head?: { sha?: string };
}

interface Runs {
  workflow_runs?: {
    name?: string;
    status?: string;
    conclusion?: string | null;
  }[];
}

/** Reads the pull request and the Actions runs on its head, which the App's `actions: read` covers. */
export class GithubPullRequests implements PullRequests {
  constructor(
    private readonly github: RepoReader,
    private readonly clock: Clock = systemClock,
  ) {}

  async state(pr: number, since: number): Promise<PullState> {
    const pull = await this.github.read<Pull>(`/pulls/${pr}`);
    if (pull.merged) return { settled: true, summary: `#${pr} merged` };
    if (pull.state === 'closed') {
      return { settled: true, summary: `#${pr} closed without merging` };
    }
    const sha = pull.head?.sha;
    if (!sha) throw new Error(`#${pr} names no head commit`);
    const { workflow_runs: runs = [] } = await this.github.read<Runs>(
      `/actions/runs?head_sha=${sha}&per_page=100`,
    );
    const head = sha.slice(0, 7);
    if (runs.length === 0) {
      const none = this.clock.now() - since >= NO_RUNS_MS;
      return {
        settled: none,
        summary: `#${pr} at ${head} ${none ? 'ran' : 'has started'} no GitHub Actions runs`,
      };
    }
    const running = runs.filter((run) => run.status !== 'completed');
    const counts = new Map<string, number>();
    for (const run of runs) {
      const outcome =
        run.status === 'completed' ? (run.conclusion ?? 'unknown') : 'running';
      counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
    }
    const failed = runs
      .filter(
        (run) =>
          run.status === 'completed' &&
          !['success', 'skipped', 'neutral'].includes(run.conclusion ?? ''),
      )
      .map((run) => run.name ?? 'unnamed');
    const tally = [...counts]
      .map(([outcome, n]) => `${n} ${outcome}`)
      .join(', ');
    return {
      settled: running.length === 0,
      summary: `#${pr} at ${head}: ${tally}${failed.length ? ` (${failed.join(', ')})` : ''}`,
    };
  }
}

/** The threads a wake continues. */
export interface WakeTarget {
  /** Continues a thread mate has a row for, as `asker`'s reply would; false when it cannot. */
  wake(request: {
    ref: ThreadRef;
    asker: string;
    text: string;
  }): Promise<boolean>;
  /** Posts a line in the thread. Never throws. */
  post(ref: ThreadRef, text: string): Promise<void>;
}

export interface WakeRequest {
  readonly ref: ThreadRef;
  readonly asker: string;
  readonly minutes: number;
  readonly note: string;
  readonly pr: number | null;
}

export class WakeRefused extends Error {
  override readonly name = 'WakeRefused';
}

export interface WakesDeps {
  /** `null` with no database: every wake is refused. */
  readonly store: WakeStore | null;
  /** `null` with no GitHub App: a pull request wake is refused. */
  readonly pulls: PullRequests | null;
  readonly log: Log;
  readonly clock?: Clock;
}

/** Sets, cancels and fires wakes. `bind` names the threads before `start`. */
export class Wakes {
  private target: WakeTarget | null = null;
  private timer: object | null = null;
  private active = false;
  private stopped = false;
  private readonly clock: Clock;

  constructor(private readonly deps: WakesDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  bind(target: WakeTarget): void {
    this.target = target;
  }

  /** Replaces the thread's pending wake, and says when in the thread. */
  async schedule(request: WakeRequest): Promise<Wake> {
    const { store, pulls } = this.deps;
    if (!store)
      throw new WakeRefused('mate-db is down, so no wake can be kept');
    const { ref, asker, minutes, pr } = request;
    if (
      !Number.isInteger(minutes) ||
      minutes < MIN_WAKE_MINUTES ||
      minutes > MAX_WAKE_MINUTES
    ) {
      throw new WakeRefused(
        `minutes must be a whole number from ${MIN_WAKE_MINUTES} to ${MAX_WAKE_MINUTES}`,
      );
    }
    if (pr !== null && !pulls) {
      throw new WakeRefused(
        'mate has no GitHub App, so it cannot watch a pull request',
      );
    }
    const note = request.note.trim().slice(0, NOTE_LIMIT);
    if (!note) throw new WakeRefused('a wake needs a note');
    const now = this.clock.now();
    const wake: Wake = {
      key: threadKey(ref),
      ref,
      asker,
      note,
      dueAt: now + minutes * 60_000,
      pr,
      createdAt: now,
    };
    await store.put(wake);
    await this.target?.post(ref, scheduledLine(wake));
    return wake;
  }

  /** Stop: drops the thread's pending wake, and says so. Never throws. */
  async cancel(ref: ThreadRef): Promise<boolean> {
    try {
      const had = (await this.deps.store?.cancel(threadKey(ref))) ?? false;
      if (had) await this.target?.post(ref, `${WAKE_MARK} wake cancelled`);
      return had;
    } catch (error) {
      this.deps.log.warn('a wake could not be cancelled', {
        threadId: ref.id,
        error: plain(error),
      });
      return false;
    }
  }

  start(): void {
    if (this.stopped || !this.deps.store) return;
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) this.clock.cancel(this.timer);
    this.timer = null;
  }

  /** Fires each wake that is due, and each pull request wake that settled. */
  async tick(): Promise<void> {
    if (this.stopped || this.active) return;
    this.active = true;
    try {
      const wakes = (await this.deps.store?.list()) ?? [];
      for (const wake of wakes) {
        if (this.stopped) break;
        await this.consider(wake);
      }
    } catch (error) {
      this.deps.log.warn('wakes could not be read; retrying', {
        error: plain(error),
      });
    } finally {
      this.active = false;
      if (!this.stopped) {
        this.timer = this.clock.after(WAKE_INTERVAL_MS, () => {
          this.timer = null;
          void this.tick();
        });
      }
    }
  }

  private async consider(wake: Wake): Promise<void> {
    const now = this.clock.now();
    const due = now >= wake.dueAt;
    let text: string | null = null;
    if (wake.pr === null) {
      if (due) text = `${WAKE_MARK} wake: ${wake.note}`;
    } else {
      const state = await this.pullState(wake);
      if (state?.settled) {
        text = `${WAKE_MARK} PR ${state.summary}. ${wake.note}`;
      } else if (due) {
        const where = state ? `: ${state.summary}` : '';
        text = `${WAKE_MARK} PR #${wake.pr} was still running at the deadline${where}. ${wake.note}`;
      }
    }
    if (text) await this.fire(wake, text);
  }

  private async pullState(wake: Wake): Promise<PullState | null> {
    try {
      return (
        (await this.deps.pulls?.state(wake.pr ?? 0, wake.createdAt)) ?? null
      );
    } catch (error) {
      this.deps.log.warn('a pull request could not be read for a wake', {
        threadId: wake.ref.id,
        pr: wake.pr,
        error: plain(error),
      });
      return null;
    }
  }

  private async fire(wake: Wake, text: string): Promise<void> {
    const { store, log } = this.deps;
    const target = this.target;
    if (!store || !target) return;
    // The claim first: a wake replaced since the list is the new one's to fire.
    if (!(await store.take(wake.key, wake.createdAt))) return;
    const woke = await target
      .wake({ ref: wake.ref, asker: wake.asker, text })
      .catch((error: unknown) => {
        log.warn('a wake could not continue its thread', {
          threadId: wake.ref.id,
          error: plain(error),
        });
        return false;
      });
    log.info(woke ? 'a wake fired' : 'a wake found no thread to continue', {
      threadId: wake.ref.id,
      pr: wake.pr,
      lateMs: wake.pr === null ? this.clock.now() - wake.dueAt : null,
    });
  }
}

function scheduledLine(wake: Wake): string {
  const at = atlantic(wake.dueAt);
  return wake.pr === null
    ? `${WAKE_MARK} checking back at ${at}`
    : `${WAKE_MARK} watching PR #${wake.pr}; checking back when its checks finish, or at ${at}`;
}

const WAKE_PARAMETERS = Type.Object({
  minutes: Type.Integer({
    minimum: MIN_WAKE_MINUTES,
    maximum: MAX_WAKE_MINUTES,
    description: `Minutes from now, ${MIN_WAKE_MINUTES} to ${MAX_WAKE_MINUTES}. With pr, the deadline.`,
  }),
  note: Type.String({
    minLength: 1,
    maxLength: NOTE_LIMIT,
    description:
      'What to do when woken. The woken turn starts with it, so name the work, the branch or PR, and what to check.',
  }),
  pr: Type.Optional(
    Type.Integer({
      minimum: 1,
      description:
        "A pull request number in the checked-out repository. mate wakes the thread once the PR is merged or closed, or every GitHub Actions run on its head has finished, or at the deadline. It does not read Atlantis's status.",
    }),
  ),
  cancel: Type.Optional(
    Type.Boolean({
      description:
        "True drops the thread's pending wake; the other fields are then ignored.",
    }),
  ),
});

function said(text: string, isError = false): ToolExecutionResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError } : {}) };
}

/**
 * The thread's own `wake` tool. `asker` is whose turn is running, or `null`
 * between turns.
 */
export function wakeTool(
  ref: ThreadRef,
  asker: () => string | null,
  wakes: Wakes,
): ToolRegistration<typeof WAKE_PARAMETERS> {
  return {
    name: WAKE_TOOL,
    description:
      "Continue this thread later, in a new turn, after some minutes or once a pull request's checks finish. One wake a thread: a new one replaces the pending one. The owner's Stop cancels it, and their replies leave it.",
    parameters: WAKE_PARAMETERS,
    replay: 'safe',
    execute: async (args) => {
      if (args.cancel) {
        const had = await wakes.cancel(ref);
        return said(
          had ? 'The pending wake is cancelled.' : 'No wake was pending.',
        );
      }
      const who = asker();
      if (!who) return said('No turn is running to set a wake from.', true);
      try {
        const wake = await wakes.schedule({
          ref,
          asker: who,
          minutes: args.minutes,
          note: args.note,
          pr: args.pr ?? null,
        });
        const at = new Date(wake.dueAt).toISOString();
        return said(
          wake.pr === null
            ? `Wake set for ${at}. End this turn; the thread continues then.`
            : `Watching #${wake.pr} until its checks finish, or ${at} at the latest. End this turn; the thread continues then.`,
        );
      } catch (error) {
        if (error instanceof WakeRefused) return said(error.message, true);
        return said(`The wake could not be saved: ${plain(error)}`, true);
      }
    },
  };
}
