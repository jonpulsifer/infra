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

const ENGINE_ENV_VARS = new Set<string>();

/**
 * Declares one of the engine's variables, so the boot check covers it. Other
 * `SPINDRIFT_*` names in the environment, such as the Service links Kubernetes
 * injects, are not the engine's and are left alone.
 */
export function engineEnvVar<const Name extends string>(name: Name): Name {
  legacyEnvName(name);
  ENGINE_ENV_VARS.add(name);
  return name;
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

/** Fails a process at boot on any declared variable whose two names disagree. */
export function assertEnvConsistent(env: Env): void {
  for (const name of ENGINE_ENV_VARS) {
    readEnv(env, name);
  }
}
