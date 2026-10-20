import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..');
// Lab facts live with the lab. A machine without the infra checkout, such as the work laptop,
// gets no memory.
const MEMORY = join(
  homedir(),
  'src/github.com/jonpulsifer/infra/apps/mate/profile/memory.md',
);
const FILES = [
  join(PACKAGE, 'persona.md'),
  MEMORY,
  join(PACKAGE, 'workstation.md'),
];

function read(file: string): string {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

export default function (pi: ExtensionAPI) {
  pi.on('before_agent_start', (event) => {
    const options = event.systemPromptOptions;
    options.appendSystemPrompt = [
      ...FILES.map(read),
      options.appendSystemPrompt,
    ]
      .filter(Boolean)
      .join('\n\n');
  });
}
