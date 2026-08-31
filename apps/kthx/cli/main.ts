#!/usr/bin/env bun
/**
 * kthx: a directory becomes `https://<name>.kthx.dev`.
 *
 *   kthx init [dir]                claim a name, write kthx.json and SKILL.md
 *   kthx deploy [dir] [--name n]   upload the directory
 *   kthx dev [dir]                 serve it on :4321 against the live backends
 *   kthx rollback [n]              serve release n (default: the one before)
 *   kthx release                   drop the hold; the newest release serves
 *   kthx ls [--all]                this site, or every site of yours, or all
 *   kthx rm                        delete the site
 *   kthx open                      open the site in a browser
 *   kthx upgrade                   replace this copy with the apex's
 *
 * The name is `kthx.json`, read from the directory and then from here. The
 * token that opens it is in `$XDG_CONFIG_HOME/kthx/sites.json`, never in the
 * directory — the directory is what gets uploaded. `KTHX_ORIGIN` points the
 * client somewhere else.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import bundledSkill from '@repo/kthx/skill.md' with { type: 'text' };
import { nameProblem } from '../server/names.ts';
import { KthxError, refusal } from './error.ts';
import { banner, faint, link, rainbow, tint } from './paint.ts';
import { pack } from './tar.ts';
import {
  buildId,
  configDir,
  updateNudge,
  upgrade,
  versionLine,
} from './upgrade.ts';

export { KthxError } from './error.ts';

export const origin = () =>
  (process.env.KTHX_ORIGIN?.trim() || 'https://kthx.dev').replace(/\/+$/, '');

/**
 * Where the site's own backends answer: the apex origin with the name as a
 * label in front of it. Every site is a host, so this is the only address
 * `kthx dev` needs to proxy to.
 */
export function siteOrigin(name: string): string {
  const { protocol, host } = new URL(origin());
  return `${protocol}//${name}.${host}`;
}

// --- what is remembered -----------------------------------------------------

export const sitesFile = () => join(configDir(), 'sites.json');

/** origin → name → token */
type Tokens = Record<string, Record<string, string>>;

/** The file's JSON, `fallback` when there is no file, and never a guess at a broken one. */
function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (error) {
    throw new KthxError('UNREADABLE', `${path}: ${(error as Error).message}`);
  }
}

function remember(name: string, token: string): void {
  const path = sitesFile();
  const tokens = readJson<Tokens>(path, {});
  tokens[origin()] = { ...tokens[origin()], [name]: token };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
  // `mode` applies only when the file is created.
  chmodSync(path, 0o600);
}

function forget(name: string): void {
  const path = sitesFile();
  const tokens = readJson<Tokens>(path, {});
  const known = tokens[origin()];
  if (known === undefined) return;
  delete known[name];
  writeFileSync(path, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

const knownToken = (name: string): string | undefined =>
  readJson<Tokens>(sitesFile(), {})[origin()]?.[name];

function tokenFor(name: string): string {
  const token = knownToken(name);
  if (token === undefined) {
    throw new KthxError(
      'NO_TOKEN',
      `${sitesFile()} has no token for ${name} at ${origin()}`,
    );
  }
  return token;
}

/**
 * The name for `dir`, from `<dir>/kthx.json` and then from the current
 * directory's — so `kthx deploy dist` inside a project root deploys the
 * project's site rather than claiming a second name for its build output.
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
    // `kthx.json` is committed and cloned, and the string in it becomes a
    // hostname to open and a path to call. The server's own rule, checked here
    // before either is built.
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

// --- the API ----------------------------------------------------------------

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

const json = (body: unknown) => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** The landing page's dice: `adj-animal-NN`. */
const ADJ = 'plum brisk quiet amber loose tiny wired damp clever spare'.split(
  ' ',
);
const ANI =
  'otter heron marten raven shrew lynx grebe wombat tapir civet'.split(' ');
const pick = (list: readonly string[]) =>
  list[Math.floor(Math.random() * list.length)];
export const mint = () =>
  `${pick(ADJ)}-${pick(ANI)}-${10 + Math.floor(Math.random() * 89)}`;

/**
 * The name `dir` deploys to, claiming one when nothing names it yet.
 *
 * `kthx.json` is written where the name was asked for: the directory for
 * `init`, which is about making that directory a site, and the current one for
 * `deploy` and `dev`, so a build output directory that is rebuilt from scratch
 * does not lose the name with it.
 */
async function nameFor(
  dir: string,
  chosen: string | undefined,
  writeTo: string,
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
  // A name whose token is already here is one this machine claimed before:
  // reuse it rather than spend a claim finding out it is taken.
  if (chosen !== undefined && knownToken(chosen) !== undefined) {
    write(writeTo, chosen);
    return chosen;
  }
  for (let attempt = 1; ; attempt += 1) {
    const name = chosen ?? mint();
    try {
      const { token } = await api<{ token: string }>('/api/sites', {
        method: 'POST',
        ...json({ name }),
      });
      remember(name, token);
      write(writeTo, name);
      if (chosen === undefined) console.log(`  no name set — uses ${name}`);
      return name;
    } catch (error) {
      const taken = error instanceof KthxError && error.code === 'TAKEN';
      if (chosen !== undefined || attempt >= 5 || !taken) throw error;
    }
  }
}

function write(dir: string, name: string): void {
  writeFileSync(
    join(dir, 'kthx.json'),
    `${JSON.stringify({ name }, null, 2)}\n`,
  );
}

// --- commands ---------------------------------------------------------------

/** The agent reference the apex publishes, or the copy this build carries. */
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

export async function init(
  dir = '.',
  options: { name?: string } = {},
): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const empty = readdirSync(dir).length === 0;
  const name = await nameFor(dir, options.name, dir);
  // A hand-written SKILL.md is somebody's work, and there is no undo here.
  const kept = !empty && existsSync(join(dir, 'SKILL.md'));
  if (!kept) writeFileSync(join(dir, 'SKILL.md'), await skill());
  if (empty) writeFileSync(join(dir, 'index.html'), STARTER);
  console.log(hello());
  console.log(
    `  ${rainbow(name)} — kthx.json${kept ? ' written; SKILL.md kept' : `, SKILL.md${empty ? ' and index.html' : ''} written`}; run kthx deploy`,
  );
  return name;
}

interface Release {
  readonly n: number;
  readonly digest: string;
  readonly url: string;
  readonly serving: number;
}

export async function deploy(
  dir = '.',
  options: { name?: string } = {},
): Promise<Release> {
  const started = Date.now();
  const name = await nameFor(dir, options.name, '.');
  const token = tokenFor(name);
  const packed = pack(dir);
  console.log(
    `  ${packed.files} files · ${kb(packed.size)} · ${short(digestOf(packed.bytes))}`,
  );
  const release = await api<Release>(`/api/sites/${name}/releases`, {
    method: 'POST',
    token,
    headers: {
      'content-type': 'application/gzip',
      'x-filename': 'site.tar.gz',
    },
    body: packed.bytes,
  });
  const held = release.serving !== release.n ? ' — held' : '';
  console.log(
    `  ${tint('→', 0.9)} ${link(release.url)}  ${faint(`(${((Date.now() - started) / 1000).toFixed(1)}s)`)} — v${release.n}${held}`,
  );
  return release;
}

interface Site {
  readonly name: string;
  readonly url: string;
  readonly serving: number | null;
  readonly held: boolean;
  readonly releases: readonly {
    readonly n: number;
    readonly digest: string;
    readonly size: number;
    readonly at: string;
  }[];
  readonly usage: Record<string, number>;
  readonly quotas: Record<string, number>;
}

const site = (name: string) =>
  api<Site>(`/api/sites/${name}`, { token: tokenFor(name) });

export async function rollback(dir = '.', n?: number): Promise<number> {
  const name = nameOf(dir);
  const found = await site(name);
  const target = n ?? found.releases.find((r) => r.n < (found.serving ?? 0))?.n;
  if (target === undefined) {
    throw new KthxError(
      'NOT_FOUND',
      `${name} has no release before v${found.serving}`,
    );
  }
  const { serving } = await api<{ serving: number }>(
    `/api/sites/${name}/serve`,
    { method: 'POST', token: tokenFor(name), ...json({ n: target }) },
  );
  console.log(
    `  v${found.serving} → v${serving} · held: new uploads do not replace v${serving} until you run kthx release`,
  );
  return serving;
}

export async function release(dir = '.'): Promise<number | null> {
  const name = nameOf(dir);
  const { serving } = await api<{ serving: number | null }>(
    `/api/sites/${name}/hold`,
    { method: 'DELETE', token: tokenFor(name) },
  );
  console.log(
    `  released: v${serving} serves, and the next upload replaces it`,
  );
  return serving;
}

/** One site as the public directory lists it. */
interface Listed {
  readonly name: string;
  readonly url: string;
  readonly serving: number | null;
  readonly releases: number;
  readonly at: string;
}

/**
 * What this directory serves — or, with no `kthx.json`, what this machine
 * holds tokens for, or, with `--all`, every site on the apex.
 *
 * A directory that is not a site is the moment someone asks "which of these
 * did I claim?", and `sites.json` has held the answer all along.
 */
export async function ls(
  dir = '.',
  options: { all?: boolean } = {},
): Promise<Site | undefined> {
  if (options.all === true) {
    await listEverySite();
    return undefined;
  }
  const name = named(dir);
  if (name === undefined) {
    await listMySites();
    return undefined;
  }
  const found = await site(name);
  const held = found.held ? ' (held)' : '';
  console.log(`  ${rainbow(found.name)}  ${link(found.url)}`);
  console.log(
    found.serving === null
      ? '  serving nothing yet'
      : `  serving v${found.serving}${held}`,
  );
  for (const r of found.releases) {
    const serving = r.n === found.serving;
    const row = `v${String(r.n).padEnd(4)} ${r.at}  ${kb(r.size).padStart(9)}  ${short(r.digest)}`;
    console.log(
      serving ? `  ${tint('→', 0.9)} ${tint(row, 0.9)}` : `    ${faint(row)}`,
    );
  }
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
  return found;
}

/**
 * Every site this machine has a token for at this origin.
 *
 * One `GET /api/sites/:name` each, because the token is what makes the answer
 * more than the public directory's. A token that no longer opens its site is
 * still printed: the name is what its owner recognises, and the code says what
 * became of it.
 */
async function listMySites(): Promise<void> {
  const names = Object.keys(
    readJson<Tokens>(sitesFile(), {})[origin()] ?? {},
  ).sort();
  if (names.length === 0) {
    console.log(`  no tokens for ${origin()} in ${sitesFile()}`);
    console.log('  run kthx init here, or kthx ls --all for every site');
    return;
  }
  const states = await Promise.all(
    names.map(async (name) => {
      try {
        const found = await site(name);
        return `${link(found.url)}  ${serves(found.serving)}${found.held ? ' (held)' : ''}`;
      } catch (error) {
        return error instanceof KthxError ? error.code : String(error);
      }
    }),
  );
  for (const [index, name] of names.entries()) {
    console.log(`  ${name.padEnd(24)} ${states[index]}`);
  }
}

/** The public directory: every live site on the apex, newest claim first. */
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
      `  ${found.name.padEnd(24)} ${link(found.url)}${' '.repeat(Math.max(0, 32 - found.url.length))} ${serves(found.serving).padEnd(12)} ${found.releases} releases  ${found.at}`,
    );
  }
  if (page.next !== null) {
    console.log(`  … more after ${page.next}`);
  }
}

const serves = (n: number | null) => (n === null ? 'nothing yet' : `v${n}`);

/**
 * Delete the site, once its name has been typed back.
 *
 * There is no undo and no account to restore from: the confirmation is the
 * only thing between a typo and a name that answers 410 forever.
 */
export async function rm(dir = '.', confirm = prompt): Promise<void> {
  const name = nameOf(dir);
  const typed = confirm(`  type ${name} to delete it, and everything in it: `);
  if (typed?.trim() !== name) {
    console.log('  nothing deleted');
    return;
  }
  await api(`/api/sites/${name}`, { method: 'DELETE', token: tokenFor(name) });
  forget(name);
  console.log(`  ${name} is gone; the name stays taken`);
}

export function openSite(dir = '.'): string {
  const url = siteOrigin(nameOf(dir));
  console.log(`  ${link(url)}`);
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    // Unreferenced: the browser it starts outlives this command, and the
    // command must not wait for it to be closed.
    Bun.spawn([opener, url], { stdio: ['ignore', 'ignore', 'ignore'] }).unref();
  } catch {
    // No opener on this machine: the URL is printed, which is the point.
  }
  return url;
}

// --- printing ---------------------------------------------------------------

const kb = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;

function digestOf(bytes: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

const short = (hex: string) => {
  const bare = hex.replace(/^sha256:/, '');
  return `sha256:${bare.slice(0, 4)}…${bare.slice(-4)}`;
};

/**
 * The banner and the one line under it: which build this is, how to replace it,
 * and how someone reading over a shoulder installs their own.
 */
const hello = () =>
  banner(
    `${versionLine()} — kthx upgrade · bun add -g ${origin()}/cli/kthx.tgz`,
  );

const USAGE = `usage: kthx <command> [dir] [--name <name>] [--all] [--version]
  init      claim a name; write kthx.json, SKILL.md and a starter page
  deploy    upload the directory as a release
  dev       serve the directory on :4321 against the site's live backends
  rollback  serve an earlier release and hold it
  release   drop the hold; the newest release serves
  ls        what the site serves; with no kthx.json, every site of yours
  ls --all  every site on the apex
  rm        delete the site
  open      open the site in a browser
  upgrade   replace this copy with the one the apex serves`;

if (import.meta.main) {
  let values: {
    name?: string;
    version?: boolean;
    all?: boolean;
    help?: boolean;
  } = {};
  let positionals: string[] = [];
  try {
    ({ values, positionals } = parseArgs({
      options: {
        name: { type: 'string' },
        version: { type: 'boolean' },
        all: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
    }));
  } catch {
    console.error(USAGE);
    process.exit(2);
  }
  const [command, argument] = positionals;
  const dir = argument ?? '.';
  // Started here and awaited at the end, so the request overlaps the command
  // instead of following it. It resolves to `null` on every failure, including
  // its own 1.5 s cap, and cannot change what the command prints or exits with.
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
      // Nobody typed `kthx` to be told the usage is wrong. Exit 0: this is the
      // answer to the question, not a refusal.
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
          const name = await nameFor(dir, values.name, '.');
          // Not `tokenFor`: `kthx.json` is committed and the token is not, so a
          // clone of the project must still be able to run the loop.
          (await import('./dev.ts')).dev(dir, {
            name,
            token: knownToken(name),
            site: siteOrigin(name),
          });
          break;
        }
        case 'rollback': {
          const n = argument === undefined ? undefined : Number(argument);
          if (n !== undefined && !(Number.isInteger(n) && n > 0)) {
            console.error(USAGE);
            process.exit(2);
          }
          await rollback('.', n);
          break;
        }
        case 'release':
          await release('.');
          break;
        case 'ls':
          await ls(dir, values);
          break;
        case 'rm':
          await rm(dir);
          break;
        case 'open':
          openSite(dir);
          break;
        case 'upgrade':
          await upgrade(origin());
          break;
        case 'mcp':
          // The reference this CLI writes names it; the stdio bridge is not in
          // this build. One honest line beats usage and exit 2.
          console.error(
            `MCP: not in this build — point the editor at ${siteOrigin(nameOf(dir))}/api/mcp with the bearer from ${sitesFile()}`,
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
