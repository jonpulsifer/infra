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
 *   kthx whoami                    which google account this machine is
 *   kthx adopt                     take a site claimed before identities
 *   kthx upgrade                   replace this copy with the apex's
 *
 * The name is `kthx.json`, read from the directory and then from here. What
 * opens a site is a Google identity: every owner-scoped call carries the ID
 * token `gcloud auth print-identity-token` mints. `sites.json` still holds the
 * bearers of sites claimed before that, and `kthx adopt` is what spends one.
 * `KTHX_ORIGIN` points the client somewhere else.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import bundledSkill from '@repo/kthx/skill.md' with { type: 'text' };
import { nameProblem } from '../server/names.ts';
import { KthxError, refusal } from './error.ts';
import { identityToken } from './identity.ts';
import { banner, faint, link, rainbow, tint } from './paint.ts';
import { REACH_MS, reach, SEND_MS, timedOut, unreachable } from './reach.ts';
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

function forget(name: string): void {
  const path = sitesFile();
  const tokens = readJson<Tokens>(path, {});
  const known = tokens[origin()];
  if (known === undefined) return;
  delete known[name];
  writeFileSync(path, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * The pre-identity bearer this machine still holds for a name.
 *
 * Nothing writes one any more: a claim mints no token. It is read by `adopt`,
 * which spends it, and by nothing else.
 */
const knownToken = (name: string): string | undefined =>
  readJson<Tokens>(sitesFile(), {})[origin()]?.[name];

/** Whether this directory names a site this machine still holds a bearer for. */
function unadopted(dir: string): boolean {
  try {
    const name = named(dir);
    return name !== undefined && knownToken(name) !== undefined;
  } catch {
    // Reading a hint must not replace the failure being reported.
    return false;
  }
}

function tokenFor(name: string): string {
  const token = knownToken(name);
  if (token === undefined) {
    throw new KthxError(
      'NO_TOKEN',
      `${sitesFile()} has no token for ${name} at ${origin()}; a site claimed with an identity needs no adopting`,
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
  init: RequestInit & { identity?: boolean } = {},
): Promise<T> {
  const { identity, ...rest } = init;
  const headers = new Headers(rest.headers);
  // One credential, minted once per process: the account is the owner, so
  // every owner-scoped call on every site carries the same token.
  if (identity === true) {
    headers.set('authorization', `Bearer ${await identityToken()}`);
  }
  // A release upload is answered once the apex has the whole tarball, so the
  // read bound would refuse a deploy that is going fine.
  const bound = rest.body === undefined ? REACH_MS : SEND_MS;
  const response = await reach(
    `${origin()}${path}`,
    { ...rest, headers },
    bound,
  ).catch((cause: Error) => {
    throw unreachable(origin(), cause, bound);
  });
  if (!response.ok) throw await refusal(response);
  // The empty fallback is for a 200 that carries nothing, not for a body that
  // stops halfway: that is the same silence the bound exists to end, and it
  // must not read as an answer.
  return (await response.json().catch((cause: unknown) => {
    if (timedOut(cause)) throw unreachable(origin(), cause, bound);
    return {};
  })) as T;
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
  for (let attempt = 1; ; attempt += 1) {
    const name = chosen ?? mint();
    try {
      // Nothing comes back to store: the account that claimed the name is what
      // opens it from here on.
      await api('/api/sites', {
        method: 'POST',
        identity: true,
        ...json({ name }),
      });
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
  const packed = pack(dir);
  console.log(
    `  ${packed.files} files · ${kb(packed.size)} · ${short(digestOf(packed.bytes))}`,
  );
  const release = await api<Release>(`/api/sites/${name}/releases`, {
    method: 'POST',
    identity: true,
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
  readonly owner: string | null;
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
  api<Site>(`/api/sites/${name}`, { identity: true });

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
    { method: 'POST', identity: true, ...json({ n: target }) },
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
    { method: 'DELETE', identity: true },
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
  readonly owner: string | null;
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
 * Every site this Google account owns.
 *
 * The directory carries the owner, so this is one walk of it filtered by the
 * address the apex just verified — not one request per name, and not a list of
 * what happens to be written down on this machine. The walk is bounded by the
 * zone's own live-site cap.
 */
async function listMySites(): Promise<void> {
  const { email } = await api<{ email: string }>('/api/whoami', {
    identity: true,
  });
  const mine: Listed[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_DIRECTORY_PAGES; page += 1) {
    const asked: Page = await api<Page>(
      after === null
        ? `/api/sites?limit=${DIRECTORY_PAGE}`
        : `/api/sites?limit=${DIRECTORY_PAGE}&after=${encodeURIComponent(after)}`,
    );
    mine.push(...asked.items.filter((found) => found.owner === email));
    after = asked.next;
    if (after === null) break;
  }
  if (mine.length === 0) {
    console.log(`  ${email} owns no site at ${origin()}`);
    console.log('  run kthx init here, or kthx ls --all for every site');
    return;
  }
  console.log(`  ${email}`);
  for (const found of mine) {
    console.log(
      `  ${found.name.padEnd(24)} ${link(found.url)}  ${serves(found.serving)}`,
    );
  }
}

/** One page of the public directory. */
interface Page {
  readonly items: Listed[];
  readonly next: string | null;
}

/** The largest page the apex answers, asked for by name rather than defaulted. */
const DIRECTORY_PAGE = 500;
/** 500 names a page against a 5000-site zone: the whole of it, and no more. */
const MAX_DIRECTORY_PAGES = 10;

/** The public directory: every live site on the apex, newest claim first. */
async function listEverySite(): Promise<void> {
  const page = await api<Page>('/api/sites');
  if (page.items.length === 0) {
    console.log(`  ${origin()} has no sites yet`);
    return;
  }
  for (const found of page.items) {
    console.log(
      `  ${found.name.padEnd(24)} ${link(found.url)}${' '.repeat(Math.max(0, 32 - found.url.length))} ${serves(found.serving).padEnd(12)} ${found.releases} releases  ${faint(found.owner ?? 'unadopted')}`,
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
  await api(`/api/sites/${name}`, { method: 'DELETE', identity: true });
  forget(name);
  console.log(`  ${name} is gone; the name stays taken`);
}

/** Which account this machine talks to the apex as. */
export async function whoami(): Promise<string> {
  const { email } = await api<{ email: string }>('/api/whoami', {
    identity: true,
  });
  console.log(`  ${email}`);
  return email;
}

/**
 * Hand a site claimed before identities to this Google account.
 *
 * The stored bearer is the proof and is spent doing it: the apex nulls the
 * hash, and this forgets the string, so there is one credential and it is the
 * account.
 */
export async function adopt(
  dir = '.',
  options: { name?: string } = {},
): Promise<string> {
  const name = options.name ?? nameOf(dir);
  await api(`/api/sites/${name}/adopt`, {
    method: 'POST',
    identity: true,
    ...json({ token: tokenFor(name) }),
  });
  forget(name);
  console.log(`  ${rainbow(name)} is yours; the old token no longer opens it`);
  return name;
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
  whoami    the google account this machine claims sites as
  adopt     take a site claimed before identities, with its old token
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
          (await import('./dev.ts')).dev(dir, {
            name,
            identity: identityToken,
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
        case 'whoami':
          await whoami();
          break;
        case 'adopt':
          await adopt(dir, values);
          break;
        case 'upgrade':
          await upgrade(origin());
          break;
        case 'mcp':
          // The reference this CLI writes names it; the stdio bridge is not in
          // this build. One honest line beats usage and exit 2.
          console.error(
            `MCP: not in this build — point the editor at ${siteOrigin(nameOf(dir))}/api/mcp with $(gcloud auth print-identity-token)`,
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
    // A site claimed before identities answers its old bearer and not this
    // account, and the bearer that fixes it is on this machine: say so rather
    // than leave "that does not open this site" as the whole of the news.
    if (error.code === 'FORBIDDEN' && unadopted(dir)) {
      console.error(
        '  this site was claimed before accounts; run kthx adopt to take it',
      );
    }
    process.exit(1);
  }
  const available = await nudge;
  if (available !== null) console.log(available);
}
