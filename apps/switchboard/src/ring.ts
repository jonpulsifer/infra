import { readFileSync } from 'node:fs';
import { type ResolveAgentOptions, resolveAgentId } from './agent.ts';
import { type Config, ConfigError, readConfig } from './config.ts';
import { GithubApp } from './github.ts';
import type { Log } from './log.ts';
import { createApp, type MissionDeps, type PersonaDeps } from './server.ts';
import { readTargets } from './targets.ts';

/**
 * Missions are on only with a token and at least one target; otherwise the
 * route answers 503 and the mission agent is never looked up. A mission agent
 * that cannot be resolved turns missions off rather than failing boot: the
 * alert path must never depend on the game agent existing.
 */
export async function resolveMission(
  config: Config,
  log: Log,
  opts: Pick<ResolveAgentOptions, 'attempts' | 'delayMs' | 'sleep'> = {},
): Promise<MissionDeps | undefined> {
  const targets = readTargets(config.targetsDir, log);
  if (!config.missionToken || targets.size === 0) return undefined;
  try {
    const agentId = await resolveAgentId(
      {
        elevenlabsApiKey: config.elevenlabsApiKey,
        agentName: config.missionAgentName,
      },
      { log, envName: 'SWITCHBOARD_MISSION_AGENT_NAME', ...opts },
    );
    log.info('missions on', { targets: targets.size });
    return { agentId, targets };
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    log.error('missions off', { reason: error.message });
    return undefined;
  }
}

/**
 * The persona routes are on only with a token; each named agent that
 * resolves is editable, and one that does not is logged and left out, so a
 * renamed agent never keeps the ringer from booting. The snapshot needs the
 * GitHub App; without it an edit is live only, and the log says so.
 */
export async function resolvePersona(
  config: Config,
  log: Log,
  opts: Pick<ResolveAgentOptions, 'attempts' | 'delayMs' | 'sleep'> & {
    readonly readKey?: (file: string) => string;
  } = {},
): Promise<PersonaDeps | undefined> {
  if (!config.personaToken) return undefined;
  const agents = new Map<string, string>();
  for (const name of config.personaAgentNames) {
    try {
      const agentId = await resolveAgentId(
        { elevenlabsApiKey: config.elevenlabsApiKey, agentName: name },
        { log, envName: 'SWITCHBOARD_PERSONA_AGENTS', ...opts },
      );
      agents.set(name, agentId);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      log.warn('persona agent skipped', { name, reason: error.message });
    }
  }
  if (agents.size === 0) {
    log.error('personas off', { reason: 'no agent resolved' });
    return undefined;
  }
  let github: GithubApp | undefined;
  if (config.githubAppId && config.githubAppKeyFile) {
    const read = opts.readKey ?? ((file: string) => readFileSync(file, 'utf8'));
    let privateKey: string;
    try {
      privateKey = read(config.githubAppKeyFile);
    } catch {
      throw new ConfigError('SWITCHBOARD_GITHUB_APP_KEY_FILE cannot be read');
    }
    try {
      github = new GithubApp({
        appId: config.githubAppId,
        privateKey,
        owner: config.githubOwner,
        repo: config.githubRepo,
        log,
      });
    } catch (error) {
      throw new ConfigError(
        error instanceof Error ? error.message : 'github app key is bad',
      );
    }
  }
  log.info('personas on', { agents: agents.size, snapshot: Boolean(github) });
  return {
    agents,
    github,
    dir: config.personaDir,
    base: config.githubBase,
  };
}

/**
 * The ringer: settles the agent id, then serves /ring and /alertmanager. A
 * ConfigError from either step is the caller's to turn into an exit status.
 */
export async function startRing(
  env: Record<string, string | undefined>,
  log: Log,
): Promise<void> {
  const config = readConfig(env);
  // Settled before the port opens, so a pod that cannot name its agent never
  // reports ready.
  const agentId = await resolveAgentId(config, { log });
  const mission = await resolveMission(config, log);
  const persona = await resolvePersona(config, log);
  const app = createApp({
    config: { ...config, agentId },
    log,
    mission,
    persona,
  });
  Bun.serve({
    port: config.port,
    hostname: '0.0.0.0',
    // Headroom over the largest Alertmanager group. Bun refuses a larger body
    // before buffering it, which the pod's memory limit could not absorb.
    maxRequestBodySize: 1024 * 1024,
    fetch: app.fetch,
  });
  log.info('switchboard listening', { port: config.port });
}
