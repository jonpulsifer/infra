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
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { version } from '../package.json' with { type: 'json' };
import { KthxError, refusal } from './error.ts';
import { reach, unreachable } from './reach.ts';

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
  /** The apex's build id, or `null` for a day the apex did not answer. */
  readonly build: string | null;
}

/** Today's answer on disk, no answer included, and never a reason to fail. */
function remember(build: string | null): void {
  try {
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    writeFileSync(
      updateFile(),
      `${JSON.stringify({ at: Date.now(), build } satisfies Seen)}\n`,
    );
  } catch {
    // An unwritable config directory costs one HEAD per command, silently.
  }
}

/**
 * The apex's build id: from `update.json` while it is less than a day old, and
 * otherwise from one `HEAD /cli/kthx.tgz` under a 1.5 s cap.
 *
 * Every failure — no network, a slow apex, an unwritable config directory, a
 * corrupt cache — is `null`, and a `null` is cached like any other answer: a
 * machine with no route to the apex pays the cap once a day, not on every
 * command. This runs beside the command the user actually typed and must not be
 * able to change what it prints, how long it takes past the cap, or what it
 * exits with.
 */
async function apexBuild(origin: string): Promise<string | null> {
  try {
    const path = updateFile();
    if (existsSync(path)) {
      const seen = JSON.parse(readFileSync(path, 'utf8')) as Partial<Seen>;
      if (
        typeof seen.at === 'number' &&
        (typeof seen.build === 'string' || seen.build === null) &&
        Date.now() - seen.at < DAY
      ) {
        return seen.build;
      }
    }
  } catch {
    // A cache that will not parse is asked again, not repaired.
  }
  const build = await fetch(`${origin}/cli/kthx.tgz`, {
    method: 'HEAD',
    signal: AbortSignal.timeout(CAP_MS),
  })
    .then((response) =>
      response.ok ? response.headers.get('x-kthx-build') : null,
    )
    .catch(() => null);
  remember(build);
  return build;
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
  // The bound covers the download too — the tarball is tens of kilobytes, and
  // a half-sent one hangs the upgrade as surely as an apex that never answers.
  const response = await reach(url).catch((cause: Error) => {
    throw unreachable(url, cause);
  });
  if (!response.ok) throw await refusal(response);
  const to = response.headers.get('x-kthx-build');
  // A directory of its own, 0700 and unguessable: the shared temp directory is
  // world-writable, and this file is handed straight to an installer.
  const dir = mkdtempSync(join(tmpdir(), 'kthx-'));
  const file = join(dir, 'kthx.tgz');
  try {
    const tarball = await response.arrayBuffer().catch((cause: Error) => {
      throw unreachable(url, cause);
    });
    await Bun.write(file, tarball);
    await Bun.$`bun add -g ${file}`.quiet().catch((cause: Error) => {
      // The shell captured why; `cause.message` is only the exit code.
      const why = (cause as { stderr?: Buffer }).stderr?.toString().trim();
      throw new KthxError(
        'UPGRADE_FAILED',
        `bun add -g: ${why || cause.message}`,
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    // The nudge was decided against a build that is no longer installed.
    rmSync(updateFile(), { force: true });
  }
  console.log(`  ${from} → ${to ?? 'installed'}`);
  console.log(
    '  upgraded the bun add -g install; any other copy of kthx is untouched',
  );
}
