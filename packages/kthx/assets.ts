/** Paths of the files a host serves from disk: the SDK, the apex page and the agent reference. */
import { join } from 'node:path';

export const SDK_PATH = join(import.meta.dir, 'sdk.js');
/**
 * The page every host serves; its builder section shows only where `data-identity`
 * is set, which is the tailnet host alone.
 */
export const LANDING_PATH = join(import.meta.dir, 'landing.html');
/** Served at `https://kthx.dev/skill.md`, and what `kthx init` writes. */
export const SKILL_PATH = join(import.meta.dir, 'skill.md');
