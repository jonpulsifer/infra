#!/usr/bin/env bun
/**
 * kthx: a directory becomes `https://<name>.kthx.dev`.
 *
 *   kthx deploy [dir] [--name n]   upload the directory; mints a name if none is set
 *   kthx dev [dir]                 serve it on :4321 with a local `/_/`
 *   kthx rollback [n]              serve release n (default: the one before) and hold
 *   kthx release                   drop the hold; the newest release serves
 *
 * The name is `<dir>/kthx.json`. The token that opens it is in
 * `$XDG_CONFIG_HOME/kthx/sites.json`, never in the directory — the directory
 * is what gets uploaded. `KTHX_ORIGIN` points the client somewhere else.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { pack } from './tar.ts';

export class KthxError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'KthxError';
  }
}

const origin = () =>
  (process.env.KTHX_ORIGIN?.trim() || 'https://kthx.dev').replace(/\/+$/, '');

// --- what is remembered -----------------------------------------------------

export const sitesFile = () =>
  join(
    process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config'),
    'kthx',
    'sites.json',
  );

/** origin → name → token */
type Tokens = Record<string, Record<string, string>>;

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
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

function tokenFor(name: string): string {
  const token = readJson<Tokens>(sitesFile(), {})[origin()]?.[name];
  if (token === undefined) {
    throw new KthxError(
      'NO_TOKEN',
      `${sitesFile()} has no token for ${name} at ${origin()}`,
    );
  }
  return token;
}

function nameOf(dir: string): string {
  const { name } = readJson<{ name?: unknown }>(join(dir, 'kthx.json'), {});
  if (typeof name !== 'string') {
    throw new KthxError(
      'NO_NAME',
      `${join(dir, 'kthx.json')} names no site; run kthx deploy first`,
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
  const response = await fetch(`${origin()}${path}`, { ...rest, headers });
  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok) {
    throw new KthxError(
      typeof body.code === 'string' ? body.code : `HTTP_${response.status}`,
      typeof body.message === 'string' ? body.message : response.statusText,
    );
  }
  return body as T;
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

async function claim(dir: string, chosen?: string): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    const name = chosen ?? mint();
    try {
      const { token } = await api<{ token: string }>('/kthx/sites', {
        method: 'POST',
        ...json({ name }),
      });
      remember(name, token);
      writeFileSync(
        join(dir, 'kthx.json'),
        `${JSON.stringify({ name }, null, 2)}\n`,
      );
      if (chosen === undefined) console.log(`  no name set — uses ${name}`);
      return name;
    } catch (error) {
      const taken = error instanceof KthxError && error.code === 'TAKEN';
      if (chosen !== undefined || attempt >= 5 || !taken) throw error;
    }
  }
}

// --- commands ---------------------------------------------------------------

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
  const named = readJson<{ name?: unknown }>(join(dir, 'kthx.json'), {}).name;
  if (
    options.name !== undefined &&
    named !== undefined &&
    named !== options.name
  ) {
    throw new KthxError(
      'NAMED',
      `${join(dir, 'kthx.json')} already names ${String(named)}; remove it to claim ${options.name}`,
    );
  }
  const name =
    typeof named === 'string' ? named : await claim(dir, options.name);
  const token = tokenFor(name);
  const packed = pack(dir);
  console.log(
    `  ${packed.files} files · ${kb(packed.size)} · ${short(digestOf(packed.bytes))}`,
  );
  const release = await api<Release>(`/kthx/sites/${name}/releases`, {
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
    `  → ${release.url}  (${((Date.now() - started) / 1000).toFixed(1)}s) — v${release.n}${held}`,
  );
  return release;
}

interface Site {
  readonly serving: number | null;
  readonly held: boolean;
  readonly releases: readonly { readonly n: number }[];
}

export async function rollback(dir = '.', n?: number): Promise<number> {
  const name = nameOf(dir);
  const token = tokenFor(name);
  const site = await api<Site>(`/kthx/sites/${name}`, { token });
  const target = n ?? site.releases.find((r) => r.n < (site.serving ?? 0))?.n;
  if (target === undefined) {
    throw new KthxError(
      'NOT_FOUND',
      `${name} has no release before v${site.serving}`,
    );
  }
  const { serving } = await api<{ serving: number }>(
    `/kthx/sites/${name}/serve`,
    { method: 'POST', token, ...json({ n: target }) },
  );
  console.log(
    `  v${site.serving} → v${serving} · held: new uploads do not replace v${serving} until you run kthx release`,
  );
  return serving;
}

export async function release(dir = '.'): Promise<number | null> {
  const name = nameOf(dir);
  const { serving } = await api<{ serving: number | null }>(
    `/kthx/sites/${name}/hold`,
    { method: 'DELETE', token: tokenFor(name) },
  );
  console.log(
    `  released: v${serving} serves, and the next upload replaces it`,
  );
  return serving;
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

const short = (hex: string) => `sha256:${hex.slice(0, 4)}…${hex.slice(-4)}`;

const USAGE =
  'usage: kthx deploy [dir] [--name <name>] | dev [dir] | rollback [n] | release';

if (import.meta.main) {
  let values: { name?: string } = {};
  let positionals: string[] = [];
  try {
    ({ values, positionals } = parseArgs({
      options: { name: { type: 'string' } },
      allowPositionals: true,
    }));
  } catch {
    console.error(USAGE);
    process.exit(2);
  }
  const [command, argument] = positionals;
  try {
    switch (command) {
      case 'deploy':
        await deploy(argument ?? '.', values);
        break;
      case 'dev':
        (await import('./dev.ts')).dev(argument ?? '.');
        break;
      case 'rollback':
        await rollback(
          '.',
          argument === undefined ? undefined : Number(argument),
        );
        break;
      case 'release':
        await release('.');
        break;
      default:
        console.error(USAGE);
        process.exit(2);
    }
  } catch (error) {
    if (!(error instanceof KthxError)) throw error;
    console.error(`${error.code}: ${error.message}`);
    process.exit(1);
  }
}
