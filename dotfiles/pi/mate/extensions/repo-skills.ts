import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const REPO_SKILLS = resolve(
  dirname(realpathSync(fileURLToPath(import.meta.url))),
  '../../../../.agents/skills',
);

// A repo with its own .agents/skills loads them as project skills, which win
// over these, so a second copy would only add a conflict warning.
function hasProjectSkills(cwd: string): boolean {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.agents', 'skills'))) return true;
    if (existsSync(join(dir, '.git')) || dirname(dir) === dir) return false;
  }
}

export default function (pi: ExtensionAPI) {
  pi.on('resources_discover', (event) => {
    if (hasProjectSkills(event.cwd) || !existsSync(REPO_SKILLS)) return;
    return { skillPaths: [REPO_SKILLS] };
  });
}
