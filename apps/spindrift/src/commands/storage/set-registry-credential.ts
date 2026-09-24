/**
 * `setRegistryCredential` stores a push credential for one registry host, for
 * registries such as Docker Hub that trust no federated identity. It is probed
 * first, then sealed under the installation keyring.
 */
import { z } from 'zod';
import { registryHostOf } from '../../domain/artifact-name.ts';
import { probeRegistry, type RegistryProbe } from '../../storage/registry.ts';
import { type Command, failed, ok } from '../types.ts';

export const setRegistryCredentialInput = z
  .object({
    /** A declared namespace or a bare host; the credential is the host's. */
    registry: z.string().trim().min(1).max(255),
    /** Stored in clear, so an operator can see which account is configured. */
    username: z.string().trim().min(1).max(255),
    /** Never returned, never logged, never stored unsealed. */
    secret: z.string().min(1).max(4096),
  })
  .strict();

export type SetRegistryCredentialInput = z.infer<
  typeof setRegistryCredentialInput
>;

export interface SetRegistryCredentialResult {
  readonly host: string;
  readonly username: string;
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

  // Keyed on the host: a builder's Docker config cannot scope a credential to a
  // namespace.
  const host = registryHostOf(input.registry);
  // GET /v2/ is not scoped to a repository, so a bare host takes a placeholder
  // segment.
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

const PROBE_SEGMENT = 'spindrift-probe';
