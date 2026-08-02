/**
 * `setRegistryCredential` — hold a push credential for one registry (§16).
 *
 * §13's rule is "native OIDC federation, nothing stored", and this is its named
 * exception. It exists because the rule has a gap the rule cannot close: a push
 * authorizes as the route that makes it, and Docker Hub trusts no federated
 * identity — it takes a username and a token or it takes nothing. An
 * installation pushing there has no credential-free path, so the choice is a
 * stored token or no Docker Hub, and pretending otherwise would leave every
 * such build failing at the last step with `unauthorized`.
 *
 * **It proves the credential before it keeps it.** The same order
 * `useSourceBucket` and `useArtifactRegistry` use, and here the check is finally
 * a strong one: with a credential in hand the probe completes the registry's own
 * challenge — the distribution token flow for a `Bearer` realm, a direct retry
 * for `Basic` — so a wrong token is refused at the form instead of surfacing as
 * a failed push twenty minutes into a build. A registry that answers anonymously
 * exercises nothing, and the act says so rather than reporting a success the
 * token did not earn.
 *
 * **The secret goes in and never comes back.** `RegistryCredentialStore` has no
 * verb that returns one, so this command could not leak a token if it tried; the
 * value is sealed under the installation keyring and opened only by
 * `dispatchBuild`, for the length of one build request.
 *
 * **Keyed on the host, not the namespace** — see the table's own note. An
 * operator setting a credential on `ghcr.io/a` sets it for `ghcr.io`, and the
 * result says so, because the alternative is a per-namespace promise the Docker
 * config a builder reads cannot keep.
 */
import { z } from 'zod';
import { registryHostOf } from '../../domain/artifact-name.ts';
import { probeRegistry, type RegistryProbe } from '../../storage/registry.ts';
import { type Command, failed, ok } from '../types.ts';

export const setRegistryCredentialInput = z
  .object({
    /**
     * A declared namespace or a bare host. Either is accepted because the
     * operator is looking at a namespace row when they press the button, and
     * the credential is the host's — so taking only a host would make the UI
     * strip a suffix the command is about to derive anyway.
     */
    registry: z.string().trim().min(1).max(255),
    /**
     * The account name. Not a secret, and stored in clear on purpose: it is the
     * half an operator has to see to know which account is configured, and both
     * Docker Hub and Artifact Registry take fixed ones a typo in is otherwise
     * undiagnosable.
     */
    username: z.string().trim().min(1).max(255),
    /** The token. Never returned, never logged, never in a row unsealed. */
    secret: z.string().min(1).max(4096),
  })
  .strict();

export type SetRegistryCredentialInput = z.infer<
  typeof setRegistryCredentialInput
>;

export interface SetRegistryCredentialResult {
  readonly host: string;
  readonly username: string;
  /** What the challenge proved, so the caller need not ask a second time. */
  readonly probe: RegistryProbe;
}

export const setRegistryCredential: Command<
  SetRegistryCredentialInput,
  SetRegistryCredentialResult
> = async (input, context) => {
  const send = context.adapters.registryTransport?.() ?? null;
  if (send === null) {
    return failed(
      'NOT_DEPLOYABLE',
      'this installation has no transport to reach a registry with',
    );
  }

  const store = context.adapters.registryCredentials?.() ?? null;
  if (store === null) {
    return failed(
      'NOT_DEPLOYABLE',
      'this installation has no credential keyring, so a registry token has nowhere durable to be kept. Set SPINDRIFT_CREDENTIAL_KEYRING in the installation Secret.',
    );
  }

  const host = registryHostOf(input.registry);
  // The probe wants a namespace and the operator may have typed a bare host.
  // A synthetic segment is enough: nothing about `GET /v2/` is scoped to a
  // repository, and the segment never leaves this line.
  const namespace = input.registry.includes('/')
    ? input.registry
    : `${host}/${PROBE_SEGMENT}`;

  const probe = await probeRegistry(namespace, send, {
    username: input.username,
    secret: input.secret,
  });

  if (!probe.answers) {
    return failed(
      'NOT_DEPLOYABLE',
      `Spindrift cannot reach ${host}: ${probe.detail}`,
    );
  }
  if (probe.authenticated === false) {
    return failed('NOT_DEPLOYABLE', probe.detail);
  }

  await store.put({
    host,
    username: input.username,
    secret: input.secret,
  });

  return ok({ host, username: input.username, probe });
};

/**
 * The repository segment a bare host is probed under.
 *
 * `GET /v2/` is not scoped to a repository, so this is only ever making the
 * string a namespace — it names nothing and reaches nothing.
 */
const PROBE_SEGMENT = 'spindrift-probe';
