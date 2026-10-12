import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { E164 } from './config.ts';
import type { Log } from './log.ts';

/**
 * The mission allow-list: one file per target, the name the key and the
 * content an E.164 number. `token` shares the Secret and is not a target, and
 * a dot name is a Kubernetes Secret mount's own bookkeeping. A missing or
 * empty directory is an empty list, which means missions off. A file that
 * holds no E.164 number is skipped with a warning naming the key, never the
 * content: a Secure Note item carries an empty `notesPlain`, and no stray
 * field may keep the ringer from booting.
 */
export function readTargets(dir: string, log?: Log): Map<string, string> {
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
      log?.warn('mission target skipped', { target: name });
      continue;
    }
    targets.set(name, content);
  }
  return targets;
}
