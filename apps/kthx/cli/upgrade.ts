/**
 * Which build this is, whether the apex has a newer one, and the one command
 * that replaces it.
 *
 * `version.json` sits beside the bundle in the tarball and beside the tarball in
 * the server's image, so both sides answer "which build" from the same bytes.
 * A checkout has no `version.json` — `bun run cli/main.ts` is not a build — and
 * says `dev`, which is also what stops a working copy from nagging about an
 * update it does not want.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { version } from '../package.json' with { type: 'json' };
import { KthxError } from './error.ts';

/** What `pack.ts` writes and the server serves as `x-kthx-build`. */
export interface Build {
  readonly version: string;
  readonly build: string;
  readonly date: string;
}

/** `$XDG_CONFIG_HOME/kthx`, which holds `sites.json` and `update.json`. */
export const configDir = (): string =>
  join(
    process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config'),
    'kthx',
  );

/** The build id of this copy, or `null` in a checkout. */
export function buildId(): string | null {
  try {
    const path = join(import.meta.dir, 'version.json');
    if (!existsSync(path)) return null;
    const read = JSON.parse(readFileSync(path, 'utf8')) as Partial<Build>;
    return typeof read.build === 'string'
      ? `${read.version ?? version}+${read.build}`
      : null;
  } catch {
    // A `version.json` that will not parse is a broken install, not a reason to
    // refuse to run: every command still works without knowing its own build.
    return null;
  }
}

/**
 * `2.0.0 · abc123def456`, or `2.0.0 · dev` in a checkout.
 *
 * Both halves come from `version.json` when there is one, because that is the
 * build that is installed: the `package.json` version compiled into the bundle
 * is what it was built from, and after an upgrade the two can differ.
 */
export const versionLine = (): string => {
  const id = buildId();
  return id === null ? `${version} · dev` : id.replace('+', ' · ');
};

// --- the nudge --------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
/** The whole budget the check may spend. Nothing waits on it for longer. */
const CAP_MS = 1500;

const updateFile = () => join(configDir(), 'update.json');

interface Seen {
  readonly at: number;
  readonly build: string;
}

/**
 * The apex's build id: from `update.json` while it is less than a day old, and
 * otherwise from one `HEAD /cli/kthx.tgz` under a 1.5 s cap.
 *
 * Every failure — no network, a slow apex, an unwritable config directory, a
 * corrupt cache — is `null`. This runs beside the command the user actually
 * typed and must not be able to change what it prints, how long it takes past
 * the cap, or what it exits with.
 */
async function apexBuild(origin: string): Promise<string | null> {
  try {
    const path = updateFile();
    if (existsSync(path)) {
      const seen = JSON.parse(readFileSync(path, 'utf8')) as Partial<Seen>;
      if (
        typeof seen.at === 'number' &&
        typeof seen.build === 'string' &&
        Date.now() - seen.at < DAY
      ) {
        return seen.build;
      }
    }
  } catch {
    // A cache that will not parse is asked again, not repaired.
  }
  try {
    const response = await fetch(`${origin}/cli/kthx.tgz`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(CAP_MS),
    });
    const build = response.headers.get('x-kthx-build');
    if (!response.ok || build === null) return null;
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    writeFileSync(
      updateFile(),
      `${JSON.stringify({ at: Date.now(), build } satisfies Seen)}\n`,
    );
    return build;
  } catch {
    return null;
  }
}

/**
 * The one line to print after the command, or `null`.
 *
 * Skipped whole — no file read, no request — for the commands the answer cannot
 * help (`upgrade` is the answer; `--version` already printed the build), when
 * the caller has said not to, when stdout is not a terminal (a script parsing
 * `kthx ls` did not ask for advice), and when `mine` is `null`, which is every
 * checkout: a working copy is not behind its own apex.
 */
export function updateNudge(ask: {
  readonly origin: string;
  readonly mine: string | null;
  readonly command: string | undefined;
  readonly versionAsked: boolean;
}): Promise<string | null> {
  if (
    ask.mine === null ||
    ask.command === 'upgrade' ||
    ask.versionAsked ||
    process.env.KTHX_NO_UPDATE_CHECK === '1' ||
    process.stdout.isTTY !== true
  ) {
    return Promise.resolve(null);
  }
  return apexBuild(ask.origin).then((theirs) =>
    theirs === null || theirs === ask.mine
      ? null
      : '  update available — kthx upgrade',
  );
}

// --- the command ------------------------------------------------------------

/**
 * Replace this copy with the apex's, through the install path the apex
 * documents.
 *
 * `bun add -g` is the only install kthx publishes, so it is the only one this
 * can undo: a copy someone cloned and linked, or vendored into a project, is
 * left where it is and told so.
 */
export async function upgrade(origin: string): Promise<void> {
  // Read before the install: `bun add -g` overwrites the very `version.json`
  // this copy answers `buildId()` from.
  const from = buildId() ?? `${version}+dev`;
  const url = `${origin}/cli/kthx.tgz`;
  const response = await fetch(url).catch((cause: Error) => {
    throw new KthxError('UNREACHABLE', `${url}: ${cause.message}`);
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      code?: unknown;
      message?: unknown;
    };
    throw new KthxError(
      typeof body.code === 'string' ? body.code : `HTTP_${response.status}`,
      typeof body.message === 'string' ? body.message : response.statusText,
    );
  }
  const to = response.headers.get('x-kthx-build');
  const file = join(tmpdir(), `kthx-${process.pid}-${Date.now()}.tgz`);
  try {
    await Bun.write(file, await response.arrayBuffer());
    await Bun.$`bun add -g ${file}`.quiet().catch((cause: Error) => {
      throw new KthxError('UPGRADE_FAILED', `bun add -g: ${cause.message}`);
    });
  } finally {
    rmSync(file, { force: true });
    // The nudge was decided against a build that is no longer installed.
    rmSync(updateFile(), { force: true });
  }
  console.log(`  ${from} → ${to ?? 'installed'}`);
  console.log(
    '  upgraded the bun add -g install; any other copy of kthx is untouched',
  );
}
