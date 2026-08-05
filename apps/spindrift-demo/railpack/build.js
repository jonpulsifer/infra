/**
 * Write down what the build saw, so the running service can prove it ran.
 *
 * The point of this file is that it is not optional decoration: railpack runs
 * `npm run build` because package.json declares it, and if the build phase
 * never happened `build-stamp.json` is missing and the server says so on `/`.
 * A demo that looked identical whether or not it was built would not
 * demonstrate anything.
 */
import { writeFileSync } from 'node:fs';

const stamp = {
  builtAt: new Date().toISOString(),
  node: process.version,
  // railpack sets neither of these; they are here to show what a build-time
  // environment actually carried, which is the question people ask first.
  platform: `${process.platform}/${process.arch}`,
};

writeFileSync(
  new URL('./build-stamp.json', import.meta.url),
  `${JSON.stringify(stamp, null, 2)}\n`,
);

console.log(
  `spindrift-demo-railpack built at ${stamp.builtAt} on ${stamp.node}`,
);
