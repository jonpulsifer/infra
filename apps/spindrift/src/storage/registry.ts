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
  /** The sentence an operator reads under the row. */
  readonly detail: string;
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
): Promise<RegistryProbe> {
  const host = registryHostOf(namespace);
  const flavour = registryFlavour(host);
  const api = registryApiBase(host);
  const base = { namespace, host, flavour, api };

  // Checked before anything is fetched, not because the far side would accept
  // it, but because this is the point where an operator-supplied string turns
  // into a request this process makes.
  if (!isRegistryNamespace(namespace)) {
    return {
      ...base,
      answers: false,
      requiresAuth: false,
      detail:
        'not a registry namespace: it must be a host and at least one path segment, as in registry.example/namespace',
    };
  }

  let response: Response;
  try {
    response = await send(new Request(api, { method: 'GET' }));
  } catch (cause) {
    return {
      ...base,
      answers: false,
      requiresAuth: false,
      detail: `${api} could not be reached: ${
        cause instanceof Error ? cause.message : 'the request did not complete'
      }`,
    };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ...base,
      answers: true,
      requiresAuth: true,
      detail: `${host} answered and asked who is calling; a push authorizes as the build route that makes it`,
    };
  }

  if (response.ok) {
    return {
      ...base,
      answers: true,
      requiresAuth: false,
      detail: `${host} answered the distribution API anonymously`,
    };
  }

  return {
    ...base,
    answers: false,
    requiresAuth: false,
    detail: `${host} answered ${response.status} at ${api}, which is not the distribution API`,
  };
}
