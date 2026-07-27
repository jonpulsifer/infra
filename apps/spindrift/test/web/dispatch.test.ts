/**
 * The browser command boundary's two acceptance criteria (Task 36b), plus the
 * property they exist to protect.
 *
 * §21 declines to declare an external API, and the plan takes the cost of one
 * anyway because a React client needs somewhere to call. What makes that
 * survivable is that the surface is **generated**, so this file's real subject
 * is not "does dispatch work" — `test/commands/registry.test.ts` already
 * settles that — but "can this surface grow a route the command layer does not
 * back". The answer has to be no by construction, and these are the assertions
 * that hold it.
 *
 * No database anywhere: every path under test refuses before a handler runs,
 * and `unreachableContext` throws if one does not.
 */
import { describe, expect, test } from 'bun:test';
import { commandNames, isCommandName } from '../../src/commands/registry.ts';
import type { Principal } from '../../src/commands/types.ts';
import {
  COMMAND_PATH_PREFIX,
  commandRoutes,
  type DispatchDeps,
  pathFor,
} from '../../src/web/dispatch.ts';
import { unreachableContext } from '../harness/context.ts';

const context = await unreachableContext();

const OPERATOR: Principal = {
  id: crypto.randomUUID(),
  displayName: 'Operator',
};

/** A boundary with somebody behind it. */
const authenticated: DispatchDeps = {
  session: async () => OPERATOR,
  context: () => context,
};

/** A boundary with nobody behind it — today's `server.ts`, and Task 37's before. */
const anonymous: DispatchDeps = {
  session: async () => null,
  context: () => {
    throw new Error('an unauthenticated request built a request context');
  },
};

function post(path: string, body: unknown = {}): Request {
  return new Request(`https://spindrift.example.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('the route table is the registry', () => {
  test('every command is reachable, and nothing else is', () => {
    // Set equality in one assertion rather than two subset checks: a route
    // that is not a command and a command that is not a route are the same
    // failure seen from two sides, and both must be impossible.
    expect(Object.keys(commandRoutes(authenticated)).sort()).toEqual(
      commandNames.map(pathFor).sort(),
    );
  });

  test('every route sits under the internal prefix', () => {
    for (const path of Object.keys(commandRoutes(authenticated))) {
      expect(path.startsWith(`${COMMAND_PATH_PREFIX}/`)).toBe(true);
    }
  });

  test('the prefix carries no version', () => {
    // §21's status for this surface is "internal, unversioned". A `/v1` here
    // is the moment somebody outside starts depending on it.
    expect(COMMAND_PATH_PREFIX).not.toMatch(/v\d/);
  });

  test('the path a command is reached at names that command', () => {
    for (const name of commandNames) {
      const tail = pathFor(name).slice(COMMAND_PATH_PREFIX.length + 1);
      expect(isCommandName(tail)).toBe(true);
    }
  });
});

describe('each command answers on its own route', () => {
  const routes = commandRoutes(authenticated);

  for (const name of commandNames) {
    test(`${name} reaches the command layer`, async () => {
      const handler = routes[pathFor(name)]!;
      const response = await handler(post(pathFor(name)));

      // An empty object satisfies no command's schema, so the refusal proves
      // the route found *this* command and handed it to `dispatch`: a route
      // wired to a name the registry lacks would answer UNKNOWN_COMMAND.
      expect(response.status).toBe(422);
      const body = (await response.json()) as {
        ok: boolean;
        failure: { code: string };
      };
      expect(body.ok).toBe(false);
      expect(body.failure.code).toBe('INVALID_INPUT');
    });
  }
});

describe('the surface is session-authenticated', () => {
  const routes = commandRoutes(anonymous);

  for (const name of commandNames) {
    test(`${name} rejects a caller with no session`, async () => {
      const response = await routes[pathFor(name)]!(post(pathFor(name)));

      expect(response.status).toBe(401);
      const body = (await response.json()) as { failure: { code: string } };
      expect(body.failure.code).toBe('UNAUTHENTICATED');
    });
  }

  test('and rejects before it builds a context', async () => {
    // `anonymous.context` throws. Reaching 401 rather than an exception is
    // what proves the session check runs first — a boundary that assembled a
    // context and then checked would leak work to unauthenticated callers.
    const name = commandNames[0]!;
    const response = await routes[pathFor(name)]!(post(pathFor(name)));
    expect(response.status).toBe(401);
  });
});

describe('a command is an act, so it takes a POST', () => {
  test('GET is refused', async () => {
    const name = commandNames[0]!;
    const routes = commandRoutes(authenticated);
    const response = await routes[pathFor(name)]!(
      new Request(`https://spindrift.example.test${pathFor(name)}`),
    );
    expect(response.status).toBe(405);
  });

  test('a body that is not JSON is refused before the session is spent', async () => {
    const name = commandNames[0]!;
    const routes = commandRoutes(authenticated);
    const response = await routes[pathFor(name)]!(
      new Request(`https://spindrift.example.test${pathFor(name)}`, {
        method: 'POST',
        body: 'not json',
      }),
    );
    expect(response.status).toBe(400);
  });
});
