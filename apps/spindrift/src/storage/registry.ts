/**
 * Asking an artifact registry whether it is there (§16).
 *
 * The sibling of `cloud.ts`, and deliberately a weaker claim than the one that
 * file makes. A bucket check proves the controller can **write**, because it
 * asks with the federated identity that would do the writing. A registry has no
 * such identity here: §13 leaves every push authorized by the route that
 * performs it — a projected service account token in-cluster, a federated token
 * for the cloud builder, the connected repository's own credential for hosted
 * CI — and none of those belong to this process.
 *
 * So what is asked is the one question that can be asked without a credential:
 * `GET /v2/`, the OCI distribution API's own root. A registry answers it two
 * ways and **both are reachable**:
 *
 * - `200` — the API is open to an anonymous read.
 * - `401` with a `WWW-Authenticate` challenge — the API is there and wants to
 *   know who is asking, which is what Docker Hub, GHCR and Artifact Registry
 *   all do for a private namespace.
 *
 * Reporting the second as unreachable would mark every private registry broken,
 * which is the failure mode this file exists to avoid. Reporting it as
 * *writable* would be the opposite lie. It answers, and who may push to it is a
 * question only a push can settle.
 */
import {
  isRegistryNamespace,
  type RegistryFlavour,
  registryApiBase,
  registryFlavour,
  registryHostOf,
} from '../domain/artifact-name.ts';

/** What one anonymous probe of a registry learned. */
export interface RegistryProbe {
  readonly namespace: string;
  readonly host: string;
  readonly flavour: RegistryFlavour;
  /** The distribution API root that was asked. */
  readonly api: string;
  /** The registry answered the distribution API at all. */
  readonly answers: boolean;
  /**
   * It answered by asking who we are.
   *
   * Not a fault, and not a permission: an anonymous probe of a private registry
   * looks exactly like this, and so does an anonymous probe of a registry that
   * would refuse the push too.
   */
  readonly requiresAuth: boolean;
  /**
   * A supplied credential was accepted by the registry.
   *
   * `null` when none was supplied, which is the ordinary case for a registry
   * the build route's own identity already reaches. The tri-state matters: a
   * boolean would make "nobody tried" and "the token is wrong" the same answer,
   * and only one of those is something an operator has to go fix.
   */
  readonly authenticated: boolean | null;
  /** The sentence an operator reads under the row. */
  readonly detail: string;
}

/** A username and token to try against the registry, where one is held. */
export interface RegistryLogin {
  readonly username: string;
  readonly secret: string;
}

/**
 * How the probe reaches a registry. All it needs is one unauthenticated GET.
 *
 * Declared here rather than imported from an adapter's own `http.ts`, which is
 * where the two identical aliases already live: this module is the far side of
 * a registry and depends on nothing but the domain, and reaching sideways into
 * a deploy adapter for a one-line function type would be the only edge between
 * them.
 */
export type RegistryTransport = (request: Request) => Promise<Response>;

/**
 * Probe one registry namespace, anonymously.
 *
 * Never throws. A registry that is not there is an answer an operator reads,
 * the same way a Target that will not connect is (§13's "connect always
 * succeeds"), so a DNS failure and a `500` come back as rows rather than as an
 * exception from inside a list.
 */
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

  // Checked before anything is fetched, not because the far side would accept
  // it, but because this is the point where an operator-supplied string turns
  // into a request this process makes.
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
      // Nothing was proved about the credential either way: an open registry
      // answers the same however it is asked, so a green tick here would be one
      // the token never earned and a red one would be a refusal that never
      // happened. `null` is what "nobody tried" means.
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

  // The credential exists to be *proved*, not filed. A stored token that the
  // registry would refuse is exactly the failure this act is placed before the
  // write to catch, and the only way to know is to complete the challenge.
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
 * Complete the registry's own authentication challenge.
 *
 * Two mechanisms, because registries genuinely use both. `Basic` is retried
 * directly. `Bearer` is the OCI distribution token flow: the challenge names a
 * `realm` and a `service`, the realm mints a token against basic credentials,
 * and the API is asked again with it. Docker Hub answers only the second, which
 * is why a `Basic`-only implementation reports a correct Docker Hub token as
 * wrong.
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
    // Two spellings for one field: the distribution spec says `token` and
    // OAuth2 says `access_token`, and real registries serve each.
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
