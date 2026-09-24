/**
 * The CLI's build id, the daily check for a newer build, and `kthx upgrade`.
 * A checkout has no `version.json`, so it reports `dev` and skips the check.
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

/** The shape of `version.json`, written by `pack.ts`. */
export interface Build {
  readonly version: string;
  readonly build: string;
  readonly date: string;
}

export const configDir = (): string =>
  join(
    process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config'),
    'kthx',
  );

/** `null` in a checkout. */
export function buildId(): string | null {
  try {
    const path = join(import.meta.dir, 'version.json');
    if (!existsSync(path)) return null;
    const read = JSON.parse(readFileSync(path, 'utf8')) as Partial<Build>;
    return typeof read.build === 'string'
      ? `${read.version ?? version}+${read.build}`
      : null;
  } catch {
    // Every command works without a build id, so a corrupt file is ignored.
    return null;
  }
}

/**
 * `2.0.0 · abc123def456`, or `2.0.0 · dev` in a checkout. The version comes
 * from `version.json` when present, since it names the installed build.
 */
export const versionLine = (): string => {
  const id = buildId();
  return id === null ? `${version} · dev` : id.replace('+', ' · ');
};

const DAY = 24 * 60 * 60 * 1000;
/** The most time the update check may add to a command. */
const CAP_MS = 1500;

const updateFile = () => join(configDir(), 'update.json');

interface Seen {
  readonly at: number;
  /** The apex's build id, or `null` for a day the apex did not answer. */
  readonly build: string | null;
}

function remember(build: string | null): void {
  try {
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    writeFileSync(
      updateFile(),
      `${JSON.stringify({ at: Date.now(), build } satisfies Seen)}\n`,
    );
  } catch {
    // An unwritable config directory costs one HEAD per command.
  }
}

/**
 * Cached for a day in `update.json`. Every failure is `null` and is cached too,
 * so a machine with no route to the apex pays the cap once a day.
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
    // An unreadable cache falls through to a fresh HEAD.
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

/** Upgrades only the `bun add -g` install, the one install kthx publishes. */
export async function upgrade(origin: string): Promise<void> {
  // Read before the install, which overwrites the `version.json` this reads.
  const from = buildId() ?? `${version}+dev`;
  const url = `${origin}/cli/kthx.tgz`;
  const response = await fetch(url).catch((cause: Error) => {
    throw new KthxError('UNREACHABLE', `${url}: ${cause.message}`);
  });
  if (!response.ok) throw await refusal(response);
  const to = response.headers.get('x-kthx-build');
  // mkdtemp makes a private 0700 directory; the shared temp dir is
  // world-writable and this file goes straight to an installer.
  const dir = mkdtempSync(join(tmpdir(), 'kthx-'));
  const file = join(dir, 'kthx.tgz');
  try {
    await Bun.write(file, await response.arrayBuffer());
    await Bun.$`bun add -g ${file}`.quiet().catch((cause: Error) => {
      // `cause.message` holds only the exit code; stderr has the reason.
      const why = (cause as { stderr?: Buffer }).stderr?.toString().trim();
      throw new KthxError(
        'UPGRADE_FAILED',
        `bun add -g: ${why || cause.message}`,
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    // The cached answer was compared against the build just replaced.
    rmSync(updateFile(), { force: true });
  }
  console.log(`  ${from} → ${to ?? 'installed'}`);
  console.log(
    '  upgraded the bun add -g install; any other copy of kthx is untouched',
  );
}
