import { type ResolveAgentOptions, resolveAgentId } from './agent.ts';
import { type Config, ConfigError, readConfig } from './config.ts';
import type { Log } from './log.ts';
import { createApp, type MissionDeps } from './server.ts';
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
  const app = createApp({ config: { ...config, agentId }, log, mission });
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
