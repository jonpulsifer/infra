import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['persona.md', 'workstation.md'];

function read(file: string): string {
  try {
    return readFileSync(join(PACKAGE, file), 'utf8').trim();
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
