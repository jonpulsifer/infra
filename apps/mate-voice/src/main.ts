import OpusScript from 'opusscript';
import { Bridge } from './bridge.ts';
import { ConfigError, readConfig } from './config.ts';
import { EngineConversation, fetchSignedUrl } from './engine.ts';
import { Health } from './health.ts';
import { MateLink } from './link.ts';
import { jsonLog as log, plain } from './log.ts';
import { Mouth } from './mouth.ts';
import { NativeSpeech } from './native.ts';
import { CHANNELS, SAMPLE_RATE } from './playback.ts';
import { ScribeEars } from './scribe.ts';

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
const speech = config.speech;
const readKey = async () =>
  speech ? (await Bun.file(speech.keyFile).text()).trim() : '';
const decoder = () =>
  new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO);
// Bun's WebSocket takes request headers; the standard constructor does not.
const connectWith = (url: string, headers: Record<string, string>) =>
  new WebSocket(url, { headers } as never);
bridge = new Bridge({
  config,
  link,
  log,
  speech:
    speech?.mode === 'native'
      ? ({ playback, ownerId, onTranscript, onBargeIn, onDeaf }) =>
          new NativeSpeech({
            ownerId,
            ears: (_userId, handlers, idleMs) =>
              new ScribeEars({
                api: speech.api,
                readKey,
                connect: connectWith,
                decoder,
                log,
                connectTimeoutMs: config.connectTimeoutMs,
                redialCap: speech.scribeRedialCap,
                idleMs,
                ...handlers,
              }),
            mouth: new Mouth({
              api: speech.api,
              voiceId: speech.voiceId,
              modelId: speech.ttsModel,
              readKey,
              connect: connectWith,
              playback,
              log,
              connectTimeoutMs: config.connectTimeoutMs,
            }),
            log,
            onTranscript,
            onBargeIn,
            onDeaf,
          })
      : undefined,
  engine:
    speech?.mode === 'engine'
      ? ({ playback, onEnd }) =>
          new EngineConversation({
            signedUrl: (signal) =>
              fetchSignedUrl(
                { api: speech.api, engineId: speech.engineId, readKey },
                signal,
              ),
            connect: (url) => new WebSocket(url),
            decoder,
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
