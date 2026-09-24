// The browser command routes are generated from the registry. Every path here
// refuses before a handler runs; `unreachableContext` throws if one does not.
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

const authenticated: DispatchDeps = {
  authenticate: async () => ({ kind: 'authenticated', principal: OPERATOR }),
  context: () => context,
};

const anonymous: DispatchDeps = {
  authenticate: async () => ({ kind: 'anonymous' }),
  context: () => {
    throw new Error('an unauthenticated request built a request context');
  },
};

const forbidden: DispatchDeps = {
  authenticate: async () => ({
    kind: 'forbidden',
    message: 'that Gateway identity is not linked',
  }),
  context: () => {
    throw new Error('a forbidden request built a request context');
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
    // The surface is internal and unversioned; a `/v1` invites outside callers.
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
      // An array fails every command's schema, so INVALID_INPUT proves the route
      // reached `dispatch`; a name the registry lacks answers UNKNOWN_COMMAND.
      const response = await handler(post(pathFor(name), []));

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
    // `anonymous.context` throws, so a 401 proves the session check runs first.
    const name = commandNames[0]!;
    const response = await routes[pathFor(name)]!(post(pathFor(name)));
    expect(response.status).toBe(401);
  });
});

describe('a trusted but unlinked Gateway identity', () => {
  test('is forbidden before a command context is built', async () => {
    const name = commandNames[0]!;
    const response = await commandRoutes(forbidden)[pathFor(name)]!(
      post(pathFor(name)),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      ok: false,
      failure: {
        code: 'FORBIDDEN',
        message: 'that Gateway identity is not linked',
      },
    });
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
