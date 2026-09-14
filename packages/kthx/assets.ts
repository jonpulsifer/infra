/**
 * The files a host serves as bytes rather than imports: the SDK, the apex
 * page, and the agent reference. Their paths, because a server reads
 * them from disk — `import.meta.dir` is this package wherever it is installed
 * from.
 */
import { join } from 'node:path';

export const SDK_PATH = join(import.meta.dir, 'sdk.js');
/**
 * Every door's page. The builder is a section of it, shown by `data-identity`
 * on the tailnet host and rendered nowhere else.
 */
export const LANDING_PATH = join(import.meta.dir, 'landing.html');
/** Served at `https://kthx.dev/skill.md`, and what `kthx init` writes. */
export const SKILL_PATH = join(import.meta.dir, 'skill.md');
