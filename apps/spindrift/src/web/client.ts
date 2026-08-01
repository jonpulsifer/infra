/**
 * The typed client — so a view never hand-writes a `fetch` (Task 36b).
 *
 * The types come from the registry, which means the browser and the command
 * layer cannot disagree about a name or an input shape without `tsc` saying so.
 * That is the point: the dispatch surface is deliberately unversioned and
 * internal, and the only thing making an unversioned protocol safe to change is
 * that both ends are compiled together.
 *
 * There is no `get`, no `list`, and no second verb. Every screen's data will
 * arrive the same way, because the alternative — one convenience helper for
 * reads — is how the boundary grows into the API §21 declined to declare.
 */
import type { commandRegistry } from '../commands/registry.ts';
import type { CommandResult } from '../commands/types.ts';
import { pathFor, type TransportFailureCode } from './command-path.ts';

type Registry = typeof commandRegistry;

/** The input a command takes, read off its registered schema. */
export type InputOf<Name extends keyof Registry> = Registry[Name] extends {
  input: { _output: infer Input };
}
  ? Input
  : never;

/** What a command's handler resolves to, unwrapped from its result envelope. */
export type OutputOf<Name extends keyof Registry> = Registry[Name] extends {
  handler: (...args: never) => Promise<CommandResult<infer Output>>;
}
  ? Output
  : never;

/**
 * The failure a caller sees.
 *
 * `code` is {@link TransportFailureCode} — the command layer's own closed set
 * plus the codes only a transport can produce — rather than a bare `string`.
 * Widening it here would quietly spend the property the rest of this layer is
 * built on: a view branching on a refusal is branching over a closed set, and
 * a code it forgot is a compile error rather than a silent fallthrough.
 */
export interface TransportFailure {
  readonly code: TransportFailureCode;
  readonly message: string;
  readonly issues?: readonly { path: string; message: string }[];
}

export type ClientResult<Output> =
  | { readonly ok: true; readonly value: Output }
  | { readonly ok: false; readonly failure: TransportFailure };

/**
 * Run a command.
 *
 * A non-JSON response is the one case that throws rather than resolving to a
 * refusal: a refusal is an answer the server gave, and a proxy returning HTML
 * is not the server answering.
 */
export async function command<Name extends keyof Registry & string>(
  name: Name,
  input: InputOf<Name>,
): Promise<ClientResult<OutputOf<Name>>> {
  const response = await fetch(pathFor(name), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // The session is a cookie; `same-origin` is the default, and it is stated
    // here so that nobody later "fixes" it to `include` and widens the surface.
    credentials: 'same-origin',
    body: JSON.stringify(input),
  });

  const body: unknown = await response.json().catch(() => null);
  if (body === null || typeof body !== 'object' || !('ok' in body)) {
    throw new Error(
      `dispatch of ${name} answered ${response.status} with no command result`,
    );
  }

  return body as ClientResult<OutputOf<Name>>;
}
