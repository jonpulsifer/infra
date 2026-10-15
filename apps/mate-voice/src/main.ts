import OpusScript from 'opusscript';
import { Bridge } from './bridge.ts';
import { ConfigError, readConfig } from './config.ts';
import { EngineConversation, fetchSignedUrl } from './engine.ts';
import { Health } from './health.ts';
import { MateLink } from './link.ts';
import { jsonLog as log, plain } from './log.ts';
import { CHANNELS, SAMPLE_RATE } from './playback.ts';

const EXIT_CONFIG = 64;

let config: ReturnType<typeof readConfig>;
try {
  config = readConfig(process.env);
} catch (error) {
  if (error instanceof ConfigError) {
    log.error('config error', { error: error.message });
    process.exit(EXIT_CONFIG);
  }
  throw error;
}

const health = new Health();
let bridge: Bridge;
const link = new MateLink({
  url: config.mateUrl,
  log,
  heartbeatMs: config.heartbeatMs,
  connectTimeoutMs: config.connectTimeoutMs,
  onOpen: () => {
    health.linked = true;
    bridge.onLinkOpen();
  },
  onMessage: (message) => {
    void bridge.onMessage(message).catch((error) => {
      log.error('message failed', { type: message.type, error: plain(error) });
    });
  },
  onClose: () => {
    health.linked = false;
    bridge.onLinkClose();
  },
});
const elevenlabs = config.elevenlabs;
bridge = new Bridge({
  config,
  link,
  log,
  engine: elevenlabs
    ? ({ playback, onEnd }) =>
        new EngineConversation({
          signedUrl: (signal) =>
            fetchSignedUrl(
              {
                api: elevenlabs.api,
                engineId: elevenlabs.engineId,
                readKey: async () =>
                  (await Bun.file(elevenlabs.keyFile).text()).trim(),
              },
              signal,
            ),
          connect: (url) => new WebSocket(url),
          decoder: () =>
            new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO),
          playback,
          log,
          connectTimeoutMs: config.connectTimeoutMs,
          onEnd,
        })
    : undefined,
});

const server = Bun.serve({
  port: config.port,
  fetch: (request) => health.fetch(request),
});
log.info('mate-voice listening', { port: server.port });
link.start();

let stopping = false;
function stop(signal: string): void {
  if (stopping) return;
  stopping = true;
  log.info('stopping', { signal });
  bridge.stop();
  link.stop();
  void server.stop(true);
  setTimeout(() => process.exit(0), 500);
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => stop(signal));
}
