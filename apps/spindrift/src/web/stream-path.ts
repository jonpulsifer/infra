/**
 * The browser-safe half of the streams: paths and message types. Every import
 * is `import type`, which keeps the database out of the client bundle.
 */
import type { RuntimeLogPage } from '../adapters/deploy/contract.ts';
import type {
  AttemptLogCursor,
  AttemptLogEntry,
} from '../domain/attempt-log.ts';
import type { FunctionLogEntry } from '../functions/contract.ts';

export const ATTEMPT_STREAM_PATH = '/internal/streams/build-attempt';
export const RUNTIME_STREAM_PATH = '/internal/streams/runtime-log';
export const FUNCTION_LOG_STREAM_PATH = '/internal/streams/function-log';
export const STREAM_PATHS = [
  ATTEMPT_STREAM_PATH,
  RUNTIME_STREAM_PATH,
  FUNCTION_LOG_STREAM_PATH,
] as const;

/** A `text/plain` GET, so it is not in {@link STREAM_PATHS}. */
export const ATTEMPT_LOG_TEXT_PATH = '/internal/streams/build-attempt.txt';

/** One page of a build's or a deploy's log, never both. */
export interface AttemptStreamMessage {
  readonly kind: 'attempt';
  readonly entries: readonly AttemptLogEntry[];
  readonly cursor: AttemptLogCursor | null;
  readonly terminal: boolean;
}

/** Sent just before the server closes the socket with 1011. */
export interface StreamErrorMessage {
  readonly kind: 'error';
  readonly message: string;
}

export type RuntimeStreamMessage = RuntimeLogPage | StreamErrorMessage;

export interface FunctionLogPage {
  readonly kind: 'function-log';
  readonly entries: readonly FunctionLogEntry[];
}

export type FunctionLogStreamMessage = FunctionLogPage | StreamErrorMessage;

export type StreamMessage =
  | AttemptStreamMessage
  | RuntimeStreamMessage
  | FunctionLogStreamMessage;
