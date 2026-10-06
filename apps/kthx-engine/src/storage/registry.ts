/**
 * Probes a registry's OCI distribution root, `GET /v2/`. A `401` or `403`
 * challenge counts as reachable, since private registries answer that way;
 * only a push can show who may push.
 */
import {
  isRegistryNamespace,
  type RegistryFlavour,
  registryApiBase,
  registryFlavour,
  registryHostOf,
} from '../domain/artifact-name.ts';

export interface RegistryProbe {
  readonly namespace: string;
  readonly host: string;
  readonly flavour: RegistryFlavour;
  readonly api: string;
  /** The registry answered the distribution API at all. */
  readonly answers: boolean;
  /** It answered with an auth challenge, which says nothing of push rights. */
  readonly requiresAuth: boolean;
  /**
   * `null` when no credential was tested; `false` when the registry refused
   * it or could not be reached.
   */
  readonly authenticated: boolean | null;
  /** The sentence an operator reads under the row. */
  readonly detail: string;
}

export interface RegistryLogin {
  readonly username: string;
  readonly secret: string;
}

export type RegistryTransport = (request: Request) => Promise<Response>;

/** A DNS failure or a `500` comes back as a probe result, not an exception. */
export async function probeRegistry(
  namespace: string,
  send: RegistryTransport,
  login?: RegistryLogin | null,
): Promise<RegistryProbe> {
  const host = registryHostOf(namespace);
  const flavour = registryFlavour(host);
  const api = registryApiBase(host);
  const base = { namespace, host, flavour, api };
  const unreachable = (detail: string): RegistryProbe => ({
    ...base,
    answers: false,
    requiresAuth: false,
    authenticated: login ? false : null,
    detail,
  });

  // Validated here, where an operator-supplied string becomes a request.
  if (!isRegistryNamespace(namespace)) {
    return unreachable(
      'not a registry namespace: it must be a host and at least one path segment, as in registry.example/namespace',
    );
  }

  let response: Response;
  try {
    response = await send(new Request(api, { method: 'GET' }));
  } catch (cause) {
    return unreachable(
      `${api} could not be reached: ${
        cause instanceof Error ? cause.message : 'the request did not complete'
      }`,
    );
  }

  if (response.ok) {
    return {
      ...base,
      answers: true,
      requiresAuth: false,
      // An open registry answers the same with or without the credential.
      authenticated: null,
      detail: login
        ? `${host} answered the distribution API anonymously, so the credential was not exercised`
        : `${host} answered the distribution API anonymously`,
    };
  }

  if (response.status !== 401 && response.status !== 403) {
    return unreachable(
      `${host} answered ${response.status} at ${api}, which is not the distribution API`,
    );
  }

  const challenged = {
    ...base,
    answers: true,
    requiresAuth: true,
  } as const;

  if (!login) {
    return {
      ...challenged,
      authenticated: null,
      detail: `${host} answered and asked who is calling; a push authorizes as the build route that makes it`,
    };
  }

  const outcome = await authenticate(api, response, login, send);
  return {
    ...challenged,
    authenticated: outcome.ok,
    detail: outcome.ok
      ? `${login.username} authenticated to ${host}`
      : `${host} refused ${login.username}: ${outcome.detail}`,
  };
}

/**
 * `Basic` is retried as is; `Bearer` first mints a token from the challenge's
 * `realm`. Docker Hub answers only `Bearer`.
 */
async function authenticate(
  api: string,
  challenge: Response,
  login: RegistryLogin,
  send: RegistryTransport,
): Promise<{ ok: boolean; detail: string }> {
  const scheme = challenge.headers.get('www-authenticate') ?? '';
  const basic = `Basic ${btoa(`${login.username}:${login.secret}`)}`;

  let authorization = basic;
  if (/^\s*bearer/i.test(scheme)) {
    const realm = challengeParam(scheme, 'realm');
    if (realm === null) {
      return { ok: false, detail: 'its Bearer challenge names no realm' };
    }
    const service = challengeParam(scheme, 'service');
    const url = new URL(realm);
    if (service !== null) url.searchParams.set('service', service);

    let minted: Response;
    try {
      minted = await send(
        new Request(url, { method: 'GET', headers: { Authorization: basic } }),
      );
    } catch (cause) {
      return {
        ok: false,
        detail:
          cause instanceof Error ? cause.message : 'the token request failed',
      };
    }
    if (!minted.ok) {
      return {
        ok: false,
        detail: `the token endpoint answered ${minted.status}`,
      };
    }

    const body = (await minted.json().catch(() => null)) as {
      token?: unknown;
      access_token?: unknown;
    } | null;
    // The distribution spec says `token`, OAuth2 `access_token`; both occur.
    const token = body?.token ?? body?.access_token;
    if (typeof token !== 'string' || token === '') {
      return { ok: false, detail: 'the token endpoint returned no token' };
    }
    authorization = `Bearer ${token}`;
  }

  let retried: Response;
  try {
    retried = await send(
      new Request(api, {
        method: 'GET',
        headers: { Authorization: authorization },
      }),
    );
  } catch (cause) {
    return {
      ok: false,
      detail: cause instanceof Error ? cause.message : 'the retry failed',
    };
  }
  return retried.ok
    ? { ok: true, detail: '' }
    : { ok: false, detail: `it answered ${retried.status}` };
}

/** One `key="value"` out of a `WWW-Authenticate` challenge. */
function challengeParam(header: string, key: string): string | null {
  return new RegExp(`${key}="([^"]*)"`, 'i').exec(header)?.[1] ?? null;
}
