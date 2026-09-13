/**
 * The files a host serves as bytes rather than imports: the SDK, the two apex
 * pages, and the agent reference. Their paths, because a server reads
 * them from disk — `import.meta.dir` is this package wherever it is installed
 * from.
 */
import { join } from 'node:path';

export const SDK_PATH = join(import.meta.dir, 'sdk.js');
export const LANDING_PATH = join(import.meta.dir, 'landing.html');
/** What the tailnet identity host serves at `/` instead of the landing page. */
export const BUILD_PATH = join(import.meta.dir, 'build.html');
/** Served at `https://kthx.dev/skill.md`, and what `kthx init` writes. */
export const SKILL_PATH = join(import.meta.dir, 'skill.md');
