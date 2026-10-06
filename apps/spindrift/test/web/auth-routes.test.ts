// Enrolment end to end over the real route table: a POST, a `Set-Cookie`, and a
// command request that carries it.
import { describe, expect, test } from 'bun:test';
import type { EnrolmentDeps } from '../../src/auth/enrol.ts';
import {
  authenticateRequest,
  type GatewayDeps,
} from '../../src/auth/gateway.ts';
import { authPathFor } from '../../src/auth/routes.ts';
import {
  clearedSessionCookies,
  LEGACY_SESSION_COOKIE,
  SESSION_COOKIE,
  sessionCookie,
} from '../../src/auth/session.ts';
import { commandNames } from '../../src/commands/registry.ts';
import type { CommandContext } from '../../src/commands/types.ts';
import { pathFor } from '../../src/web/dispatch.ts';
import { MCP_PATH } from '../../src/web/mcp-route.ts';
import { webRoutes } from '../../src/web/routes.ts';
import { createAuthenticator } from '../harness/authenticator.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { fixtureManifest } from '../harness/installation.ts';

const database = withIsolatedDatabase();

const RELYING_PARTY = {
  id: 'spindrift.example.test',
  name: 'example',
  origin: 'https://spindrift.example.test',
} as const;

const SHIPPED_TOKEN = 'the-token-in-the-installation-secret';

// A stand-in, so this file never needs a client build.
const CLIENT = { '/': new Response('the client document') };

// Assembled as `serve.ts` does, with the command context built from the same
// auth deps, so every principal here came out of the auth surface.
function serve() {
  const auth: EnrolmentDeps & GatewayDeps = {
    db: database().db,
    clock: { now: () => new Date('2026-01-01T00:00:00Z') },
    relyingParty: RELYING_PARTY,
    enrolmentToken: SHIPPED_TOKEN,
    gateway: null,
  };

  const routes = webRoutes(
    CLIENT,
    {
      authenticate: (request) => authenticateRequest(request, auth),
      context: (principal) =>
        ({
          principal,
          clock: auth.clock,
          db: auth.db,
          adapters: {
            deploy: () => null,
            build: () => null,
            store: () => {
              throw new Error('no store in this test');
            },
            repository: () => null,
            supplyChain: () => {
              throw new Error('auth route reached the supply chain');
            },
          },
          manifest: manifest,
        }) satisfies CommandContext,
    },
    auth,
    {
      db: auth.db,
      clock: auth.clock,
      // No secret, so the webhook route never reaches `current`.
      secret: async () => null,
      current: () => {
        throw new Error('an auth-route test reached installation state');
      },
    },
    {
      db: auth.db,
      clock: auth.clock,
      secret: null,
    },
    {
      authenticate: () => {
        throw new Error('an auth-route test reached the setup route');
      },
      auth: () => {
        throw new Error('an auth-route test reached the GitHub App identity');
      },
    },
    {
      db: auth.db,
      current: () => {
        throw new Error('an auth-route test read the installation');
      },
    },
    {
      authenticate: async () => ({ kind: 'anonymous' as const }),
      context: () => {
        throw new Error('an auth-route test reached the MCP surface');
      },
    },
  );

  return { auth, routes };
}

const manifest = await fixtureManifest();

function post(path: string, body: unknown = {}, cookie?: string): Request {
  return new Request(`${RELYING_PARTY.origin}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  });
}

function cookieFrom(response: Response): string | null {
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(';');
    if (pair?.startsWith(`${SESSION_COOKIE}=`)) return pair;
  }
  return null;
}

// Widened once: `webRoutes`' precise type suits `Bun.serve`, not lookup by path.
type Routes = Record<string, unknown>;

async function enrolOverHttp(routes: Routes): Promise<Response> {
  const begun = await call(routes, authPathFor('enrol/begin'), {
    token: SHIPPED_TOKEN,
  });
  const body = (await begun.json()) as { value: { challenge: string } };

  const authenticator = await createAuthenticator({
    rpId: RELYING_PARTY.id,
    origin: RELYING_PARTY.origin,
  });

  return call(routes, authPathFor('enrol/complete'), {
    token: SHIPPED_TOKEN,
    ...(await authenticator.register(body.value.challenge)),
  });
}

function handlerFor(
  routes: Routes,
  path: string,
): (request: Request) => Promise<Response> {
  const handler = routes[path];
  if (typeof handler !== 'function') {
    throw new Error(`${path} is not a handler on the route table`);
  }
  return handler as (request: Request) => Promise<Response>;
}

function call(
  routes: Routes,
  path: string,
  body: unknown = {},
  cookie?: string,
): Promise<Response> {
  return handlerFor(routes, path)(post(path, body, cookie));
}

describe('enrolling over the route table', () => {
  test('answers with a session cookie, and not with the token', async () => {
    const { routes } = serve();
    const response = await enrolOverHttp(routes);

    expect(response.status).toBe(200);

    const cookie = cookieFrom(response);
    expect(cookie).not.toBeNull();

    const header = response.headers.get('set-cookie') ?? '';
    expect(header).toContain('HttpOnly');

    // Only in the HttpOnly cookie: any script, injected or not, can read the body.
    const body = await response.text();
    const value = cookie!.slice(`${SESSION_COOKIE}=`.length);
    expect(body).not.toContain(value);
  });

  test('and the session it mints reaches a command', async () => {
    const { routes } = serve();
    const cookie = cookieFrom(await enrolOverHttp(routes));
    expect(cookie).not.toBeNull();

    const name =
      commandNames.find((n) => n === 'completeCreationDraft') ??
      commandNames[0]!;
    const response = await call(routes, pathFor(name), {}, cookie!);

    // 422, not 401: the session check passed and the empty input failed validation.
    expect(response.status).toBe(422);
    const body = (await response.json()) as { failure: { code: string } };
    expect(body.failure.code).toBe('INVALID_INPUT');
  });

  test('while the same command with no cookie is still 401', async () => {
    const { routes } = serve();
    await enrolOverHttp(routes);

    const name = commandNames[0]!;
    const response = await call(routes, pathFor(name), {});

    expect(response.status).toBe(401);
    const body = (await response.json()) as { failure: { code: string } };
    expect(body.failure.code).toBe('UNAUTHENTICATED');
  });
});

describe('the session route', () => {
  test('says nobody before an enrolment', async () => {
    const { routes } = serve();
    const path = authPathFor('session');
    const response = await handlerFor(
      routes,
      path,
    )(new Request(`${RELYING_PARTY.origin}${path}`));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { value: { principal: unknown } };
    // A read, not a refusal: the client picks its screen from this answer.
    expect(body.value.principal).toBeNull();
  });

  test('and names the operator after one', async () => {
    const { routes } = serve();
    const cookie = cookieFrom(await enrolOverHttp(routes));

    const path = authPathFor('session');
    const response = await handlerFor(
      routes,
      path,
    )(
      new Request(`${RELYING_PARTY.origin}${path}`, {
        headers: { cookie: cookie! },
      }),
    );

    const body = (await response.json()) as {
      value: { principal: { displayName: string } | null };
    };
    expect(body.value.principal?.displayName).toBe('Operator');
  });
});

describe('credential Settings over the route table', () => {
  test('lists the enrolled passkey only for an authenticated operator', async () => {
    const { routes } = serve();
    const cookie = cookieFrom(await enrolOverHttp(routes));
    const path = authPathFor('credentials');

    const anonymous = await handlerFor(
      routes,
      path,
    )(new Request(`${RELYING_PARTY.origin}${path}`));
    expect(anonymous.status).toBe(401);

    const authenticated = await handlerFor(
      routes,
      path,
    )(
      new Request(`${RELYING_PARTY.origin}${path}`, {
        headers: { cookie: cookie! },
      }),
    );
    expect(authenticated.status).toBe(200);
    const body = (await authenticated.json()) as {
      value: { passkeys: unknown[]; gatewayAvailable: boolean };
    };
    expect(body.value.passkeys).toHaveLength(1);
    expect(body.value.gatewayAvailable).toBe(false);
  });
});

describe('signing out over the route table', () => {
  test('clears the cookie and ends the session', async () => {
    const { routes } = serve();
    const cookie = cookieFrom(await enrolOverHttp(routes));

    const out = await call(routes, authPathFor('signout'), {}, cookie!);
    expect(out.headers.getSetCookie()).toEqual([...clearedSessionCookies()]);

    // The session is dead on the server too, not only cleared in the browser.
    const name = commandNames[0]!;
    const after = await call(routes, pathFor(name), {}, cookie!);
    expect(after.status).toBe(401);
  });
});

describe('a session under the legacy cookie name', () => {
  async function legacySession(routes: Routes) {
    const cookie = cookieFrom(await enrolOverHttp(routes));
    const token = cookie!.slice(`${SESSION_COOKIE}=`.length);
    return { token, legacy: `${LEGACY_SESSION_COOKIE}=${token}` };
  }

  function readSession(routes: Routes, cookie: string): Promise<Response> {
    const path = authPathFor('session');
    return handlerFor(
      routes,
      path,
    )(new Request(`${RELYING_PARTY.origin}${path}`, { headers: { cookie } }));
  }

  const expiredLegacy = `${LEGACY_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

  test('signs in, and moves to the new name on that response', async () => {
    const { routes } = serve();
    const { token, legacy } = await legacySession(routes);

    const response = await readSession(routes, legacy);
    const body = (await response.json()) as {
      value: { principal: { displayName: string } | null };
    };
    expect(body.value.principal?.displayName).toBe('Operator');
    expect(response.headers.getSetCookie()).toEqual([
      sessionCookie(token),
      expiredLegacy,
    ]);

    const moved = await call(
      routes,
      pathFor(commandNames[0]!),
      {},
      cookieFrom(response)!,
    );
    expect(moved.status).not.toBe(401);
  });

  test('moves on a command response too', async () => {
    const { routes } = serve();
    const { token, legacy } = await legacySession(routes);

    const response = await call(routes, pathFor(commandNames[0]!), {}, legacy);
    expect(response.status).not.toBe(401);
    expect(response.headers.getSetCookie()).toEqual([
      sessionCookie(token),
      expiredLegacy,
    ]);
  });

  test('that opens nothing is only expired', async () => {
    const { routes } = serve();
    await enrolOverHttp(routes);

    const response = await readSession(
      routes,
      `${LEGACY_SESSION_COOKIE}=a-token-nobody-issued`,
    );
    expect(response.headers.getSetCookie()).toEqual([expiredLegacy]);
  });

  test('beside the new name is only expired', async () => {
    const { routes } = serve();
    const { token, legacy } = await legacySession(routes);

    const response = await readSession(
      routes,
      `${legacy}; ${SESSION_COOKIE}=${token}`,
    );
    expect(response.headers.getSetCookie()).toEqual([expiredLegacy]);
  });

  test('signs out without being moved', async () => {
    const { routes } = serve();
    const { legacy } = await legacySession(routes);

    const out = await call(routes, authPathFor('signout'), {}, legacy);
    expect(out.headers.getSetCookie()).toEqual([...clearedSessionCookies()]);

    const after = await call(routes, pathFor(commandNames[0]!), {}, legacy);
    expect(after.status).toBe(401);
  });

  test('is neither read nor moved by /mcp', async () => {
    const { routes } = serve();
    const { legacy } = await legacySession(routes);

    const response = await handlerFor(
      routes,
      MCP_PATH,
    )(
      new Request(`${RELYING_PARTY.origin}${MCP_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: legacy },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

describe('the auth surface refuses what it should', () => {
  test('a wrong token gets no challenge', async () => {
    const { routes } = serve();
    const response = await call(routes, authPathFor('enrol/begin'), {
      token: 'a guess',
    });
    expect(response.status).toBe(401);
  });

  test('a second enrolment reads as a conflict, not as bad input', async () => {
    // 409: the installation is claimed, so the caller has nothing to fix.
    const { routes } = serve();
    await enrolOverHttp(routes);

    const response = await call(routes, authPathFor('enrol/begin'), {
      token: SHIPPED_TOKEN,
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { failure: { code: string } };
    expect(body.failure.code).toBe('TOKEN_SPENT');
  });

  test('a body missing its fields is refused before any ceremony', async () => {
    const { routes } = serve();
    const response = await call(routes, authPathFor('enrol/complete'), {
      token: SHIPPED_TOKEN,
    });
    expect(response.status).toBe(422);
  });

  test('and a GET on an act is refused', async () => {
    const { routes } = serve();
    const path = authPathFor('enrol/begin');
    const response = await handlerFor(
      routes,
      path,
    )(new Request(`${RELYING_PARTY.origin}${path}`));
    expect(response.status).toBe(405);
  });
});
