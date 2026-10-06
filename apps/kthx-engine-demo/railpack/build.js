// Writes build-stamp.json; server.js reports it missing when the build phase never ran.
import { writeFileSync } from 'node:fs';

const stamp = {
  builtAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
};

writeFileSync(
  new URL('./build-stamp.json', import.meta.url),
  `${JSON.stringify(stamp, null, 2)}\n`,
);

console.log(
  `spindrift-demo-railpack built at ${stamp.builtAt} on ${stamp.node}`,
);
