/**
 * mate's own record of each thread, beside pi's tables in mate-db, so a
 * restarted mate finds every open thread whether or not it holds a sandbox.
 * The thread engine writes `state`, `turns` and `turn`; the brain writes the
 * session and sandbox columns.
 */
import type { SandboxGoneReason } from './lease.ts';
import type { MessageRef, SurfaceName, ThreadRef } from './surface.ts';

export type ThreadRowState = 'open' | 'closed';

/** The turn in flight: what a resume needs to answer the right person. */
export interface TurnMark {
  readonly asker: string;
  readonly message: MessageRef;
  readonly startedAt: number;
  /** Resumes started for this turn; at the limit a restart discards it instead. */
  readonly resumes: number;
}

export interface ThreadRow {
  /** `threadKey(ref)`. */
  readonly key: string;
  readonly ref: ThreadRef;
  readonly state: ThreadRowState;
  /** The pi session id: the key, or `key~n` after the nth quarantine. */
  readonly sessionId: string;
  /** Session ids set aside as corrupt: kept for inspection, deleted with the thread. */
  readonly quarantined: readonly string[];
  /** The Sandbox last known to hold the thread's checkout; the hands find it by label. */
  readonly sandbox: string | null;
  /** Why the sandbox an earlier turn used is gone; the next prompt tells the model once. */
  readonly workspaceReset: SandboxGoneReason | null;
  /** Turns taken, held against MATE_MAX_TURNS_PER_THREAD across restarts and reopens. */
  readonly turns: number;
  readonly turn: TurnMark | null;
  /** Fixed at birth: only the row's insert writes it. A row from before profiles reads as DEFAULT_PROFILE. */
  readonly profile: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ThreadRowPatch {
  readonly state?: ThreadRowState;
  readonly sessionId?: string;
  readonly quarantined?: readonly string[];
  readonly sandbox?: string | null;
  readonly workspaceReset?: SandboxGoneReason | null;
  readonly turns?: number;
  readonly turn?: TurnMark | null;
}

export interface ThreadListFilter {
  readonly state?: ThreadRowState;
  readonly surface?: SurfaceName;
}

export interface ThreadStore {
  get(key: string): Promise<ThreadRow | undefined>;
  /** Creates the row (session id = key) under `profile`, or marks an existing one open and keeps its own profile; returns it. */
  open(ref: ThreadRef, profile: string): Promise<ThreadRow>;
  /** Counts one turn of `profile` on the UTC `day` if fewer than `cap` were counted; atomic across processes. */
  claimTurn(profile: string, day: string, cap: number): Promise<boolean>;
  /** Writes only the columns given, and `updatedAt`. */
  patch(key: string, patch: ThreadRowPatch): Promise<void>;
  list(filter: ThreadListFilter): Promise<ThreadRow[]>;
  /** Closed rows of `profiles` last touched before `before`, oldest first, for the retention sweep. */
  closedBefore(
    before: number,
    limit: number,
    profiles: readonly string[],
  ): Promise<ThreadRow[]>;
  /** Deletes the row only while it is still closed and untouched since `before`; returns it if so. */
  deleteClosed(key: string, before: number): Promise<ThreadRow | undefined>;
  delete(key: string): Promise<void>;
}
