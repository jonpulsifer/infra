import { resolveAgentId } from './agent.ts';
import { ConfigError, readConfig } from './config.ts';
import { jsonLog as log } from './log.ts';
import { createApp } from './server.ts';

const EXIT_CONFIG = 64;

function exitOnConfigError(error: unknown): never {
  if (error instanceof ConfigError) {
    log.error('config error', { error: error.message });
    process.exit(EXIT_CONFIG);
  }
  throw error;
}

function loadConfig() {
  try {
    return readConfig(process.env);
  } catch (error) {
    return exitOnConfigError(error);
  }
}

const config = loadConfig();
// Settled before the port opens, so a pod that cannot name its agent never
// reports ready.
const agentId = await resolveAgentId(config, { log }).catch(exitOnConfigError);
const app = createApp({ config: { ...config, agentId }, log });

log.info('switchboard listening', { port: config.port });

export default {
  port: config.port,
  hostname: '0.0.0.0',
  // Headroom over the largest Alertmanager group. Bun refuses a larger body
  // before buffering it, which the pod's memory limit could not absorb.
  maxRequestBodySize: 1024 * 1024,
  fetch: app.fetch,
};
