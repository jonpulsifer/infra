import { Places, parsePlaces } from './places.ts';
import { app } from './server.ts';
import { Tempest } from './tempest.ts';
import { Upstream } from './upstream.ts';

const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const upstream = new Upstream();
const tempest = new Tempest(
  upstream,
  list(process.env.TEMPESTWX_TOKENS),
  new Set(list(process.env.TEMPESTWX_IGNORE_STATIONS).map(Number)),
);
const places = new Places(
  upstream,
  tempest,
  parsePlaces(process.env.WEATHER_PLACES ?? ''),
);
const port = Number(process.env.WEATHER_PORT ?? 8080);

if (!tempest.configured) {
  console.warn('TEMPESTWX_TOKENS is empty; answering from MSC alone');
}

const server = Bun.serve({
  port,
  fetch: app({ upstream, tempest, places }).fetch,
});
console.info(
  `weather listening on :${server.port} with ${places.named.length} place(s)`,
);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void server.stop().then(() => process.exit(0));
  });
}
