import { resolveAgentId } from './agent.ts';
import { readConfig } from './config.ts';
import type { Log } from './log.ts';
import { createApp, type MissionDeps } from './server.ts';
import { readTargets } from './targets.ts';

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
  // Missions are on only with a token and at least one target; otherwise the
  // route answers 503 and the mission agent is never looked up.
  const targets = readTargets(config.targetsDir);
  let mission: MissionDeps | undefined;
  if (config.missionToken && targets.size > 0) {
    mission = {
      agentId: await resolveAgentId(
        {
          elevenlabsApiKey: config.elevenlabsApiKey,
          agentName: config.missionAgentName,
        },
        { log },
      ),
      targets,
    };
    log.info('missions on', { targets: targets.size });
  }
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
