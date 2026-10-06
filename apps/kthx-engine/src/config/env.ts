/**
 * The engine's own environment variables are named `KTHX_ENGINE_<X>`. Each
 * one's former `SPINDRIFT_<X>` name is still read when the new name is unset,
 * so a Secret keyed by the old names keeps working until it is re-keyed.
 */

type Env = Record<string, string | undefined>;

export const ENV_PREFIX = 'KTHX_ENGINE_';
export const LEGACY_ENV_PREFIX = 'SPINDRIFT_';

export class EnvConflictError extends Error {
  override readonly name = 'EnvConflictError';
}

export function legacyEnvName(name: string): string {
  if (!name.startsWith(ENV_PREFIX)) {
    throw new Error(`${name} is not a ${ENV_PREFIX}* variable`);
  }
  return `${LEGACY_ENV_PREFIX}${name.slice(ENV_PREFIX.length)}`;
}

function isSet(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

/**
 * Reads `name`, then its `SPINDRIFT_*` name. Throws when both are set to
 * different values, naming both variables and neither value.
 */
export function readEnv(env: Env, name: string): string | undefined {
  const legacy = legacyEnvName(name);
  const current = env[name];
  const fallback = env[legacy];
  if (isSet(current) && isSet(fallback) && current.trim() !== fallback.trim()) {
    throw new EnvConflictError(
      `${name} and ${legacy} are both set and differ; ${legacy} is the old name of ${name}, so set only ${name}`,
    );
  }
  return isSet(current) ? current : fallback;
}

/** Fails a process at boot on any `SPINDRIFT_*` that disagrees with its new name. */
export function assertEnvConsistent(env: Env): void {
  for (const key of Object.keys(env)) {
    if (key.startsWith(LEGACY_ENV_PREFIX)) {
      readEnv(env, `${ENV_PREFIX}${key.slice(LEGACY_ENV_PREFIX.length)}`);
    }
  }
}
