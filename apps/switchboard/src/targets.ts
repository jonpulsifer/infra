import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError, E164 } from './config.ts';

/**
 * The mission allow-list: one file per target, the name the key and the
 * content an E.164 number. `token` shares the Secret and is not a target, and
 * a dot name is a Kubernetes Secret mount's own bookkeeping. A missing or
 * empty directory is an empty list, which means missions off; a malformed
 * number is a config error naming the key, never the number.
 */
export function readTargets(dir: string): Map<string, string> {
  const targets = new Map<string, string>();
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return targets;
  }
  for (const name of names) {
    if (name.startsWith('.') || name === 'token') continue;
    let content: string;
    try {
      content = readFileSync(join(dir, name), 'utf8').trim();
    } catch {
      continue;
    }
    if (!E164.test(content)) {
      throw new ConfigError(
        `mission target ${name} must be E.164: a + then 8-15 digits`,
      );
    }
    targets.set(name, content);
  }
  return targets;
}
