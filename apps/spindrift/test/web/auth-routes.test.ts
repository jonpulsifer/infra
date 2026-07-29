/**
 * The gap this closes, asserted end to end (Task 37).
 *
 * `apps/spindrift/README.md` said it plainly: *"Nobody can sign in... every
 * command route answers 401."* Every other test in `test/auth/` proves a piece
 * of the mechanism; this one proves the outcome, over the real route table, in
 * the units a browser actually deals in — a POST, a `Set-Cookie`, and a
 * subsequent request that carries it.
 *
 * The one assertion worth reading first: **a session minted by the auth surface
 * reaches a command**. That is the sentence the README will stop needing.
 */
import { describe, expect, test } from 'bun:test';
import type { EnrolmentDeps } from '../../src/auth/enrol.ts';
import {
  authenticateRequest,
  type GatewayDeps,
} from '../../src/auth/gateway.ts';
import { authPathFor } from '../../src/auth/routes.ts';
import { SESSION_COOKIE } from '../../src/auth/session.ts';
import { commandNames } from '../../src/commands/registry.ts';
import type { CommandContext } from '../../src/commands/types.ts';
import { pathFor } from '../../src/web/dispatch.ts';
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

/** A stand-in for the client, so this file never depends on a build having run. */
const CLIENT = { '/': new Response('the client document') };

/**
 * The real table, assembled the way `serve.ts` assembles it.
 *
 * The command context is built from the same auth deps, so a principal that
 * arrives here really did come out of the auth surface rather than from a
 * fixture the test wrote directly.
 */
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

/** Pull the session cookie out of a `Set-Cookie` the way a browser would. */
function cookieFrom(response: Response): string | null {
  const header = response.headers.get('set-cookie');
  if (header === null) return null;
  const [pair] = header.split(';');
  return pair?.startsWith(`${SESSION_COOKIE}=`) ? pair : null;
}

/**
 * The table as a lookup.
 *
 * `webRoutes` returns a precise object type, which is the right type for
 * `Bun.serve` and the wrong one for a test that looks a path up by name — so
 * the widening happens once, here, rather than at each call.
 */
type Routes = Record<string, unknown>;

/** Enrol over the routes, exactly as the browser would. */
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

/** Look a handler up by path, refusing anything that is not one. */
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

    // The token is in the cookie and nowhere in the body: a value the client's
    // own script can read is a value an injected script can read.
    const body = await response.text();
    const value = cookie!.slice(`${SESSION_COOKIE}=`.length);
    expect(body).not.toContain(value);
  });

  test('and the session it mints reaches a command', async () => {
    // The whole point. Before this, every command route answered 401.
    const { routes } = serve();
    const cookie = cookieFrom(await enrolOverHttp(routes));
    expect(cookie).not.toBeNull();

    const name =
      commandNames.find((n) => n === 'completeCreationDraft') ??
      commandNames[0]!;
    const response = await call(routes, pathFor(name), {}, cookie!);

    // 422, not 401: an empty object satisfies no command's schema, so the
    // request got past the session check and was refused by the command's own
    // input validation — which is the boundary behaving exactly as designed.
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
    // A read, not a refusal: the client asks this to decide which screen to
    // render, and "nobody" is a perfectly good answer to render the enrolment
    // screen from.
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
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');

    // Not just cleared in the browser — the token is dead on the server too.
    const name = commandNames[0]!;
    const after = await call(routes, pathFor(name), {}, cookie!);
    expect(after.status).toBe(401);
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
    // 409 because the caller has nothing to fix: the installation is claimed.
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
