/**
 * The one way a view calls a command. Its types come from the registry, so
 * `tsc` catches drift across the unversioned dispatch protocol.
 */
import type { commandRegistry } from '../commands/registry.ts';
import type { CommandResult } from '../commands/types.ts';
import { pathFor, type TransportFailureCode } from './command-path.ts';
import { reportSessionExpired } from './session-events.ts';

type Registry = typeof commandRegistry;

export type InputOf<Name extends keyof Registry> = Registry[Name] extends {
  input: { _output: infer Input };
}
  ? Input
  : never;

export type OutputOf<Name extends keyof Registry> = Registry[Name] extends {
  handler: (...args: never) => Promise<CommandResult<infer Output>>;
}
  ? Output
  : never;

/**
 * Distributed over the names, so a name beside another command's input fails
 * to type check.
 */
export type Call = {
  [Name in keyof Registry & string]: readonly [Name, InputOf<Name>];
}[keyof Registry & string];

/** Mapped by position, so each read destructures to its own output type. */
export type OutputsOf<Calls extends readonly Call[]> = {
  [Index in keyof Calls]: Calls[Index] extends readonly [
    infer Name extends keyof Registry & string,
    unknown,
  ]
    ? OutputOf<Name>
    : never;
};

/** `code` stays a closed set, so a view branches over known refusals only. */
export interface TransportFailure {
  readonly code: TransportFailureCode;
  readonly message: string;
  readonly issues?: readonly { path: string; message: string }[];
}

export type ClientResult<Output> =
  | { readonly ok: true; readonly value: Output }
  | { readonly ok: false; readonly failure: TransportFailure };

/** Throws on a non-JSON response, such as a proxy's HTML error page. */
export async function command<Name extends keyof Registry & string>(
  name: Name,
  input: InputOf<Name>,
): Promise<ClientResult<OutputOf<Name>>> {
  const response = await fetch(pathFor(name), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // The session is a cookie. Stated so nobody widens it to `include`.
    credentials: 'same-origin',
    body: JSON.stringify(input),
  });

  const body: unknown = await response.json().catch(() => null);
  if (body === null || typeof body !== 'object' || !('ok' in body)) {
    throw new Error(
      `dispatch of ${name} answered ${response.status} with no command result`,
    );
  }

  const result = body as ClientResult<OutputOf<Name>>;
  // An expired session re-gates the shell here, since no caller can render it.
  if (!result.ok && result.failure.code === 'UNAUTHENTICATED') {
    reportSessionExpired();
  }
  return result;
}
