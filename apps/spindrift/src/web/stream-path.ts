/**
 * The client-safe edge of the streaming boundary (§17).
 *
 * `streams.ts` is the server-side WebSocket transport, and behind it sits
 * `db/notify.ts`, `db/schema.ts`, and `drizzle-orm` itself — none of that has
 * business in the browser. But the browser still needs the route each stream
 * upgrades on, and the shape of the messages it receives over the socket, so
 * those live in their own module rather than in `streams.ts`.
 *
 * The load-bearing lines are the two `import type`s below: `AttemptLogCursor`
 * and `AttemptLogEntry` come from `domain/attempt-log.ts`, and `RuntimeLogPage`
 * comes from `adapters/deploy/contract.ts`. Both are `import type`, which
 * TypeScript erases at compile time, so Bun never turns either into a module
 * edge — same as `command-path.ts` erasing `CommandName` out of
 * `commands/registry.ts`. That is what keeps `db/schema.ts`, `db/notify.ts`,
 * and `drizzle-orm` out of `client.ts`'s reachable graph.
 * `test/web/client-bundle.test.ts` builds the client and asserts this holds.
 *
 * `streams.ts` re-exports from here rather than this module importing from
 * `streams.ts`, so the server side is unchanged and there is exactly one
 * definition of each of these things.
 */
import type { RuntimeLogPage } from '../adapters/deploy/contract.ts';
import type {
  AttemptLogCursor,
  AttemptLogEntry,
} from '../domain/attempt-log.ts';
import type { FunctionLogEntry } from '../functions/contract.ts';

/**
 * Unversioned, and named so that nobody has to be told twice — the same
 * status as `COMMAND_PATH_PREFIX` in `command-path.ts`. §21 permits a
 * purpose-specific integration protocol for the browser; these are that and
 * nothing more.
 */
export const ATTEMPT_STREAM_PATH = '/internal/streams/build-attempt';
export const RUNTIME_STREAM_PATH = '/internal/streams/runtime-log';
export const FUNCTION_LOG_STREAM_PATH = '/internal/streams/function-log';
export const STREAM_PATHS = [
  ATTEMPT_STREAM_PATH,
  RUNTIME_STREAM_PATH,
  FUNCTION_LOG_STREAM_PATH,
] as const;

/** One page of the terminating attempt stream — build or deploy, never both. */
export interface AttemptStreamMessage {
  readonly kind: 'attempt';
  readonly entries: readonly AttemptLogEntry[];
  readonly cursor: AttemptLogCursor | null;
  readonly terminal: boolean;
}

/** A stream that failed to read rather than one that closed cleanly. */
export interface StreamErrorMessage {
  readonly kind: 'error';
  readonly message: string;
}

/** One page of the non-terminating runtime tail (§17). */
export type RuntimeStreamMessage = RuntimeLogPage | StreamErrorMessage;

/** One batch of the non-terminating Function log tail. */
export interface FunctionLogPage {
  readonly kind: 'function-log';
  readonly entries: readonly FunctionLogEntry[];
}

export type FunctionLogStreamMessage = FunctionLogPage | StreamErrorMessage;

export type StreamMessage =
  | AttemptStreamMessage
  | RuntimeStreamMessage
  | FunctionLogStreamMessage;
