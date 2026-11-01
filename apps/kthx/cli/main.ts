#!/usr/bin/env bun
/**
 * kthx: a directory becomes `https://<name>.kthx.dev`. A site is the folder
 * `<name>/` in the sites bucket, and `kthx deploy` writes it with the caller's
 * own Application Default Credentials. `KTHX_ORIGIN` points the client at
 * another apex, `KTHX_SITES_BUCKET` at another bucket.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import bundledSkill from '@repo/kthx/skill.md' with { type: 'text' };
import {
  type Bucket,
  claimMarker,
  listMarkers,
  type Marker,
  readMarker,
  removeSite,
  SiteRaced,
  syncSite,
} from '../server/bucket.ts';
import { nameProblem } from '../server/names.ts';
import { type Credentials, loadCredentials } from './adc.ts';
import { KthxError, refusal } from './error.ts';
import { collect } from './files.ts';
import { banner, faint, link, rainbow, tint } from './paint.ts';
import { buildId, updateNudge, upgrade, versionLine } from './upgrade.ts';

export { KthxError } from './error.ts';

export const origin = () =>
  (process.env.KTHX_ORIGIN?.trim() || 'https://kthx.dev').replace(/\/+$/, '');

export const DEFAULT_SITES_BUCKET = 'bluenose-kthx-sites';

export const sitesBucket = () =>
  process.env.KTHX_SITES_BUCKET?.trim() || DEFAULT_SITES_BUCKET;

/** How a command asks a person something. Tests answer for them. */
export interface Io {
  /** A terminal is attached, so a question can be answered. */
  readonly tty: boolean;
  ask(question: string): string | null;
}

export const terminal: Io = {
  get tty() {
    return process.stdin.isTTY === true && process.stdout.isTTY === true;
  },
  ask: (question) => prompt(question),
};

let held: Credentials | null = null;

/** Read once per process; `forgetCredentials` is for tests. */
export function credentials(): Credentials {
  held ??= loadCredentials();
  return held;
}

export function forgetCredentials(): void {
  held = null;
}

function bucket(): Bucket {
  const creds = credentials();
  return {
    bucketName: sitesBucket(),
    auth: { token: () => creds.accessToken() },
  };
}

// Asked of the origin, since the zone may not be the origin's host. Never read
// from the committed project: this URL is where `kthx dev` sends an ID token.
let apex: Promise<{ url: string }> | null = null;

export async function siteUrl(name: string): Promise<string> {
  apex ??= api<{ url: string }>('/api');
  const { protocol, host } = new URL((await apex).url);
  return `${protocol}//${name}.${host}`;
}

/** Only a missing file gets `fallback`; a corrupt one throws. */
function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (error) {
    throw new KthxError('UNREADABLE', `${path}: ${(error as Error).message}`);
  }
}

/**
 * Reads `<dir>/kthx.json`, then `./kthx.json`, so `kthx deploy dist` in a
 * project root deploys the project's site.
 */
function named(dir: string): string | undefined {
  for (const at of [join(dir, 'kthx.json'), 'kthx.json']) {
    const { name } = readJson<{ name?: unknown }>(at, {});
    if (name === undefined) continue;
    if (typeof name !== 'string') {
      throw new KthxError(
        'INVALID_NAME',
        `${at} names ${JSON.stringify(name)}, which is not a name`,
      );
    }
    // A cloned `kthx.json` becomes a hostname and an object prefix, so it must
    // pass the server's name rule first.
    const problem = nameProblem(name);
    if (problem !== null) {
      throw new KthxError(
        problem,
        `${at} names ${JSON.stringify(name)}, which is not a name a site can have`,
      );
    }
    return name;
  }
  return undefined;
}

function nameOf(dir: string): string {
  const name = named(dir);
  if (name === undefined) {
    throw new KthxError(
      'NO_NAME',
      `no kthx.json in ${resolve(dir)} or here; run kthx init to claim a name`,
    );
  }
  return name;
}

async function api<T>(
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<T> {
  const { token, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token !== undefined) headers.set('authorization', `Bearer ${token}`);
  const response = await fetch(`${origin()}${path}`, {
    ...rest,
    headers,
  }).catch((cause: Error) => {
    throw new KthxError('UNREACHABLE', `${origin()}: ${cause.message}`);
  });
  if (!response.ok) throw await refusal(response);
  return (await response.json().catch(() => ({}))) as T;
}

/** The same `adj-animal-NN` dice as the landing page. */
const ADJ = 'plum brisk quiet amber loose tiny wired damp clever spare'.split(
  ' ',
);
const ANI =
  'otter heron marten raven shrew lynx grebe wombat tapir civet'.split(' ');
const pick = (list: readonly string[]) =>
  list[Math.floor(Math.random() * list.length)];
export const mint = () =>
  `${pick(ADJ)}-${pick(ANI)}-${10 + Math.floor(Math.random() * 89)}`;

interface Standing {
  readonly available: boolean;
  readonly why: string | null;
}

/**
 * The site's marker, written for `me` if the name is free. A name the server
 * reserves, or holds for a built app, is refused; one somebody already has
 * answers their marker, and the caller decides what that means.
 */
async function claim(
  target: Bucket,
  name: string,
  me: string,
): Promise<Marker> {
  const standing = await api<Standing>(
    `/api/names/${encodeURIComponent(name)}`,
  );
  if (!standing.available && standing.why !== 'TAKEN') {
    throw new KthxError(
      standing.why ?? 'TAKEN',
      `${name} is not a name a site can have`,
    );
  }
  if (standing.available) {
    const claimed = await claimMarker(target, name, me);
    if (claimed !== null) return claimed;
  }
  // Taken, or lost the race to another claim: whose is it?
  const marker = await readMarker(target, name);
  if (marker !== null) return marker;
  throw new KthxError('TAKEN', `${name} is held for a built app`);
}

/**
 * The name for `dir`: its `kthx.json`, else `--name`, else a minted one that
 * is claimed here. `deploy` and `dev` write `kthx.json` to `.`, so a rebuilt
 * output directory keeps its name.
 */
async function nameFor(
  dir: string,
  chosen: string | undefined,
  writeTo: string,
  me: string,
): Promise<string> {
  const already = named(dir);
  if (already !== undefined) {
    if (chosen !== undefined && chosen !== already) {
      throw new KthxError(
        'NAMED',
        `kthx.json already names ${already}; remove it to claim ${chosen}`,
      );
    }
    return already;
  }
  if (chosen !== undefined) {
    const problem = nameProblem(chosen);
    if (problem !== null) {
      throw new KthxError(problem, `${chosen} is not a name a site can have`);
    }
    write(writeTo, chosen);
    return chosen;
  }
  const target = bucket();
  for (let attempt = 1; ; attempt += 1) {
    const name = mint();
    const marker = await claim(target, name, me).catch((error: unknown) => {
      if (error instanceof KthxError && error.code === 'TAKEN') return null;
      throw error;
    });
    if (marker !== null && marker.owner === me) {
      write(writeTo, name);
      console.log(`  no name set — uses ${name}`);
      return name;
    }
    if (attempt >= 5) {
      throw new KthxError('TAKEN', 'five minted names in a row were taken');
    }
  }
}

function write(dir: string, name: string): void {
  writeFileSync(
    join(dir, 'kthx.json'),
    `${JSON.stringify({ name }, null, 2)}\n`,
  );
}

async function skill(): Promise<string> {
  const response = await fetch(`${origin()}/skill.md`, {
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (response === null || !response.ok) return bundledSkill;
  const text = await response.text().catch(() => '');
  return text.trim() === '' ? bundledSkill : text;
}

const STARTER = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>kthx</title>
<script src="/api/sdk.js"></script>
<h1>It works.</h1>
<p>Edit index.html, then run <code>kthx deploy</code>.</p>
`;

const when = (iso: string | null): string =>
  iso === null ? 'never' : `${iso.slice(0, 16).replace('T', ' ')} UTC`;

/**
 * Ownership is a courtesy: the owner's name is on the marker and anyone with
 * write access to the bucket may write over it, after saying so.
 */
function overrule(
  marker: Marker,
  verb: 'Overwrite' | 'Delete',
  force: boolean,
  io: Io,
): void {
  if (force) return;
  const question = `site "${marker.name}" is owned by ${marker.owner || 'nobody'} (last deploy ${when(marker.deployed)}). ${verb}? [y/N] `;
  if (!io.tty) {
    throw new KthxError(
      'NOT_YOURS',
      `site "${marker.name}" is owned by ${marker.owner || 'nobody'}; with no terminal to ask, pass --force to ${verb.toLowerCase()} it`,
    );
  }
  const answer = io.ask(question)?.trim().toLowerCase();
  if (answer !== 'y' && answer !== 'yes') {
    throw new KthxError('DECLINED', `${marker.name} is left as it is`);
  }
}

export async function init(
  dir = '.',
  options: { name?: string } = {},
): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const empty = readdirSync(dir).length === 0;
  const me = await credentials().email();
  const name = await nameFor(dir, options.name, dir, me);
  const marker = await claim(bucket(), name, me);
  if (marker.owner !== me) {
    throw new KthxError(
      'TAKEN',
      `${name} is owned by ${marker.owner || 'nobody'} (last deploy ${when(marker.deployed)})`,
    );
  }
  // An existing SKILL.md may be hand-written, so it is never overwritten.
  const kept = !empty && existsSync(join(dir, 'SKILL.md'));
  if (!kept) writeFileSync(join(dir, 'SKILL.md'), await skill());
  if (empty) writeFileSync(join(dir, 'index.html'), STARTER);
  console.log(hello());
  console.log(
    `  ${rainbow(name)} — kthx.json${kept ? ' written; SKILL.md kept' : `, SKILL.md${empty ? ' and index.html' : ''} written`}; run kthx deploy`,
  );
  return name;
}

export interface Deployed {
  readonly name: string;
  readonly url: string;
  readonly uploaded: readonly string[];
  readonly unchanged: number;
  readonly deleted: readonly string[];
}

export async function deploy(
  dir = '.',
  options: { name?: string; force?: boolean } = {},
  io: Io = terminal,
): Promise<Deployed> {
  const started = Date.now();
  // Refused before anything is claimed or sent: a bad kthx.json, then files.
  named(dir);
  const files = collect(dir);
  const me = await credentials().email();
  const name = await nameFor(dir, options.name, '.', me);
  const target = bucket();
  const marker =
    (await readMarker(target, name)) ?? (await claim(target, name, me));
  if (marker.owner !== me)
    overrule(marker, 'Overwrite', options.force === true, io);

  let synced: Awaited<ReturnType<typeof syncSite>>;
  try {
    synced = await syncSite(target, name, files, me, marker.generation);
  } catch (error) {
    if (error instanceof SiteRaced) throw new KthxError('RACED', error.message);
    throw error;
  }
  const url = await siteUrl(name);
  const size = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  console.log(
    `  ${files.length} files · ${kb(size)} · ${synced.uploaded.length} uploaded, ${synced.unchanged} unchanged, ${synced.deleted.length} deleted`,
  );
  console.log(
    `  ${tint('→', 0.9)} ${link(url)}  ${faint(`(${((Date.now() - started) / 1000).toFixed(1)}s)`)}`,
  );
  return {
    name,
    url,
    uploaded: synced.uploaded,
    unchanged: synced.unchanged,
    deleted: synced.deleted,
  };
}

/** One entry in the public directory. */
interface Listed {
  readonly name: string;
  readonly url: string;
  readonly deployed: string | null;
}

export async function ls(
  dir = '.',
  options: { all?: boolean } = {},
): Promise<Marker | undefined> {
  if (options.all === true) {
    await listEverySite();
    return undefined;
  }
  const name = named(dir);
  if (name === undefined) {
    await listMySites();
    return undefined;
  }
  const marker = await readMarker(bucket(), name);
  if (marker === null) {
    throw new KthxError('NOT_FOUND', `${name} has no site; run kthx deploy`);
  }
  console.log(`  ${rainbow(name)}  ${link(await siteUrl(name))}`);
  console.log(
    `  owned by ${marker.owner || 'nobody'} · last deploy ${when(marker.deployed)}`,
  );
  if (marker.owner === (await credentials().email())) await usage(name);
  return marker;
}

/** What the server meters for the site; skipped when it cannot be asked. */
async function usage(name: string): Promise<void> {
  const found = await credentials()
    .idToken()
    .then((token) =>
      api<{
        usage: Record<string, number>;
        quotas: Record<string, number>;
      }>(`/api/sites/${name}`, { token }),
    )
    .catch(() => null);
  if (found === null) return;
  for (const [what, used, limit] of [
    ['db', found.usage.db_bytes, found.quotas.db_bytes],
    ['files', found.usage.files_bytes, found.quotas.files_bytes],
  ] as const) {
    if (used === undefined || limit === undefined) continue;
    console.log(`  ${what.padEnd(6)} ${kb(used)} of ${kb(limit)}`);
  }
  const { ai_requests_today, ai_tokens_today } = found.usage;
  if (ai_requests_today !== undefined && ai_tokens_today !== undefined) {
    console.log(
      `  ai     ${ai_requests_today} of ${found.quotas.ai_requests_day} requests, ${ai_tokens_today} of ${found.quotas.ai_tokens_day} tokens today`,
    );
  }
}

async function listMySites(): Promise<void> {
  const me = await credentials().email();
  const mine = (await listMarkers(bucket())).filter((one) => one.owner === me);
  if (mine.length === 0) {
    console.log(`  ${me} owns no site in gs://${sitesBucket()}`);
    console.log('  run kthx init here, or kthx ls --all for every site');
    return;
  }
  for (const marker of mine) {
    console.log(
      `  ${marker.name.padEnd(24)} ${link(await siteUrl(marker.name))}  ${when(marker.deployed)}`,
    );
  }
}

async function listEverySite(): Promise<void> {
  const page = await api<{ items: Listed[]; next: string | null }>(
    '/api/sites',
  );
  if (page.items.length === 0) {
    console.log(`  ${origin()} has no sites yet`);
    return;
  }
  for (const found of page.items) {
    console.log(
      `  ${found.name.padEnd(24)} ${link(found.url)}${' '.repeat(Math.max(0, 32 - found.url.length))} ${when(found.deployed)}`,
    );
  }
  if (page.next !== null) {
    console.log(`  … more after ${page.next}`);
  }
}

/**
 * The name must be typed back. The owner's own site also goes from the
 * server, database and files included; anyone's folder then goes from the
 * bucket, marker last, and the name is free.
 */
export async function rm(
  dir = '.',
  options: { force?: boolean } = {},
  io: Io = terminal,
): Promise<void> {
  const name = nameOf(dir);
  const target = bucket();
  const marker = await readMarker(target, name);
  if (marker === null) {
    throw new KthxError('NOT_FOUND', `${name} has no site`);
  }
  const me = await credentials().email();
  if (marker.owner !== me)
    overrule(marker, 'Delete', options.force === true, io);
  const typed = io.ask(`  type ${name} to delete it, and everything in it: `);
  if (typed?.trim() !== name) {
    console.log('  nothing deleted');
    return;
  }
  if (marker.owner === me) {
    await credentials()
      .idToken()
      .then((token) => api(`/api/sites/${name}`, { method: 'DELETE', token }))
      .catch((error: unknown) => {
        // The bucket delete below still frees the name; the server drops the
        // site's database and files when it sees the marker gone.
        const code = error instanceof KthxError ? error.code : String(error);
        console.log(
          faint(`  the server did not delete it (${code}); the bucket will`),
        );
      });
  }
  await removeSite(target, name);
  console.log(`  ${name} is gone, and the name is free`);
}

/**
 * Sends no credential: the server opens this to a login in `KTHX_ADMIN_LOGINS`
 * on the identity host. With no terminal, `prompt` returns null.
 */
export async function nuke(
  { yes = false } = {},
  confirm = prompt,
): Promise<void> {
  if (!yes) {
    const typed = confirm(`  type NUKE to delete every site on ${origin()}: `);
    if (typed?.trim() !== 'NUKE') {
      console.log('  nothing deleted');
      return;
    }
  }
  let counts: { deleted: number; failed: number };
  try {
    counts = await api<{ deleted: number; failed: number }>('/api/sites', {
      method: 'DELETE',
    });
  } catch (cause) {
    // The server answers 404 when `KTHX_ADMIN_LOGINS` is empty.
    if (cause instanceof KthxError && cause.code === 'NOT_FOUND') {
      throw new KthxError(
        'NO_NUKE',
        `${origin()} has no nuke. It opens for a named tailnet login on the identity host — point KTHX_ORIGIN at that host from a device on the tailnet.`,
      );
    }
    throw cause;
  }
  console.log(
    `  ${counts.deleted} deleted${counts.failed ? `, ${counts.failed} failed` : ''}; every site's name is free, and names reserved for built apps stay taken`,
  );
}

export async function openSite(dir = '.'): Promise<string> {
  const url = await siteUrl(nameOf(dir));
  console.log(`  ${link(url)}`);
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    // unref: the browser outlives this command.
    Bun.spawn([opener, url], { stdio: ['ignore', 'ignore', 'ignore'] }).unref();
  } catch {
    // No opener here; the URL is already printed.
  }
  return url;
}

const kb = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;

const hello = () =>
  banner(
    `${versionLine()} — kthx upgrade · bun add -g ${origin()}/cli/kthx.tgz`,
  );

const USAGE = `usage: kthx <command> [dir] [--name <name>] [--force] [--all] [--version]
  init      claim a name; write kthx.json, SKILL.md and a starter page
  deploy    sync the directory to the site; --force writes over someone else's
  dev       serve the directory on :4321 against the site's live backends
  ls        the site's owner and last deploy; with no kthx.json, every site of yours
  ls --all  every site on the apex
  rm        delete the site and free the name
  open      open the site in a browser
  upgrade   replace this copy with the one the apex serves
  nuke      delete every site on the apex (tailnet admin; --yes skips the prompt)

Credentials are Google Application Default Credentials:
  gcloud auth application-default login`;

if (import.meta.main) {
  let values: {
    name?: string;
    version?: boolean;
    all?: boolean;
    help?: boolean;
    yes?: boolean;
    force?: boolean;
  } = {};
  let positionals: string[] = [];
  try {
    ({ values, positionals } = parseArgs({
      options: {
        name: { type: 'string' },
        version: { type: 'boolean' },
        all: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        yes: { type: 'boolean' },
        force: { type: 'boolean' },
      },
      allowPositionals: true,
    }));
  } catch {
    console.error(USAGE);
    process.exit(2);
  }
  const [command, argument] = positionals;
  const dir = argument ?? '.';
  // Started first so the request overlaps the command. It resolves `null` on any
  // failure, so it never changes the output or the exit code.
  const nudge = updateNudge({
    origin: origin(),
    mine: buildId(),
    command,
    versionAsked: values.version === true,
  });
  try {
    if (values.version === true && command === undefined) {
      console.log(versionLine());
    } else if (command === undefined || values.help === true) {
      // Bare `kthx` asks for help, so this exits 0.
      console.log(hello());
      console.log(USAGE);
    } else {
      switch (command) {
        case 'init':
          await init(dir, values);
          break;
        case 'deploy':
          await deploy(dir, values);
          break;
        case 'dev': {
          const creds = credentials();
          const me = await creds.email();
          const name = await nameFor(dir, values.name, '.', me);
          const target = bucket();
          if ((await readMarker(target, name)) === null) {
            await claim(target, name, me);
          }
          (await import('./dev.ts')).dev(dir, {
            name,
            authorization: () => creds.idToken().catch(() => null),
            site: await siteUrl(name),
          });
          break;
        }
        case 'ls':
          await ls(dir, values);
          break;
        case 'rm':
          await rm(dir, values);
          break;
        case 'open':
          await openSite(dir);
          break;
        case 'upgrade':
          await upgrade(origin());
          break;
        case 'nuke':
          await nuke(values);
          break;
        case 'mcp':
          // This build has no stdio MCP bridge, so point at the HTTP endpoint.
          console.error(
            `MCP: not in this build — point the editor at ${await siteUrl(nameOf(dir))}/api/mcp with an ID token: gcloud auth print-identity-token`,
          );
          process.exitCode = 1;
          break;
        default:
          console.error(USAGE);
          process.exit(2);
      }
    }
  } catch (error) {
    if (!(error instanceof KthxError)) throw error;
    console.error(`${error.code}: ${error.message}`);
    process.exit(1);
  }
  const available = await nudge;
  if (available !== null) console.log(available);
}
