import { ConfigError } from './config.ts';

/**
 * What this process is. `ring` places calls for mate and Alertmanager on
 * offsite; `board` shows the folly PBX's calls. Unset is `ring`, so the
 * offsite Deployment, which names no role, keeps working.
 */
export type Role = 'ring' | 'board';

export function readRole(env: Record<string, string | undefined>): Role {
  const value = env.SWITCHBOARD_ROLE?.trim() || 'ring';
  if (value === 'ring' || value === 'board') return value;
  throw new ConfigError(`SWITCHBOARD_ROLE must be ring or board, got ${value}`);
}
