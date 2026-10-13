type Env = Record<string, string | undefined>;

export const ENV_PREFIX = 'KTHX_ENGINE_';

export function engineEnvVar<const Name extends string>(name: Name): Name {
  if (!name.startsWith(ENV_PREFIX)) {
    throw new Error(`${name} is not a ${ENV_PREFIX}* variable`);
  }
  return name;
}

export function readEnv(env: Env, name: string): string | undefined {
  return env[name];
}
