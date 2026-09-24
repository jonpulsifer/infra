import { ConfigError, readConfig } from './config.ts';
import { jsonLog as log } from './log.ts';
import { createApp } from './server.ts';

const EXIT_CONFIG = 64;

function loadConfig() {
  try {
    return readConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      log.error('config error', { error: error.message });
      process.exit(EXIT_CONFIG);
    }
    throw error;
  }
}

const config = loadConfig();
const app = createApp({ config, log });

log.info('switchboard listening', { port: config.port });

export default {
  port: config.port,
  hostname: '0.0.0.0',
  fetch: app.fetch,
};
