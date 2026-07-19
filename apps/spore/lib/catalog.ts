import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { normalizeMac } from './ipxe';

const ipxeContent = z
  .string()
  .refine((content) => content.startsWith('#!ipxe'), {
    message: 'content must begin with #!ipxe',
  });

const profileSchema = z
  .object({
    name: z.string().trim().min(1),
    description: z.string().optional(),
    content: ipxeContent,
  })
  .strict();

const scriptSchema = z
  .object({
    description: z.string().optional(),
    content: ipxeContent,
  })
  .strict();

const hostSchema = z
  .object({
    hostname: z.string().trim().min(1),
    profile: z.string().optional(),
  })
  .strict();

const nativeBootTargetSchema = z
  .object({
    hostname: z.string().trim().min(1),
    macAddress: z.string(),
    protocol: z.literal('raspberry-pi-http'),
  })
  .strict();

const catalogInputSchema = z
  .object({
    serverOrigin: z.string(),
    allowUnknownHosts: z.boolean(),
    defaultProfile: z.string().nullable().default(null),
    profiles: z.record(z.string(), profileSchema),
    scripts: z.record(z.string(), scriptSchema),
    hosts: z.record(z.string(), hostSchema),
    nativeBootTargets: z.record(z.string(), nativeBootTargetSchema).default({}),
  })
  .strict();

export type BootCatalogInput = z.input<typeof catalogInputSchema>;
export type BootProfile = Readonly<z.output<typeof profileSchema>>;
export type BootScript = Readonly<z.output<typeof scriptSchema>>;
export type BootHost = Readonly<z.output<typeof hostSchema>>;
export interface NativeBootTarget {
  readonly hostname: string;
  readonly macAddress: string;
  readonly protocol: 'raspberry-pi-http';
  readonly artifactBaseUrl: string;
}

export const nativeBootArtifacts = [
  'boot.img',
  'boot.sig',
  'nix-store.squashfs',
] as const;
export type NativeBootArtifact = (typeof nativeBootArtifacts)[number];

export function isNativeBootArtifact(
  value: string,
): value is NativeBootArtifact {
  return nativeBootArtifacts.some((artifact) => artifact === value);
}

export interface BootCatalog {
  readonly serverOrigin: string;
  readonly allowUnknownHosts: boolean;
  readonly defaultProfile: string | null;
  readonly profiles: Readonly<Record<string, BootProfile>>;
  readonly scripts: Readonly<Record<string, BootScript>>;
  readonly hosts: Readonly<Record<string, BootHost>>;
  readonly nativeBootTargets: Readonly<Record<string, NativeBootTarget>>;
}

const stableIdPattern = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const safeScriptPathPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function issueText(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : 'catalog';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

function assertServerOrigin(serverOrigin: string): void {
  let url: URL;
  try {
    url = new URL(serverOrigin);
  } catch {
    throw new Error('serverOrigin must be an absolute URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('serverOrigin must use http: or https:');
  }
  if (url.username || url.password) {
    throw new Error('serverOrigin must not contain credentials');
  }
  if (url.search || url.hash) {
    throw new Error('serverOrigin must not contain a query or fragment');
  }
  if (url.pathname.endsWith('/')) {
    throw new Error('serverOrigin must not end with a slash');
  }
  if (url.origin === 'null') {
    throw new Error('serverOrigin must have an authority');
  }
}

function assertStableProfileId(id: string): void {
  if (!stableIdPattern.test(id)) {
    throw new Error(`invalid profile id: ${id}`);
  }
}

export function isSafeScriptPath(path: string): boolean {
  const segments = path.split('/');
  return (
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.includes('//') &&
    safeScriptPathPattern.test(path) &&
    segments.every((segment) => segment !== '.' && segment !== '..')
  );
}

function assertSafeScriptPath(path: string): void {
  if (!isSafeScriptPath(path)) {
    throw new Error(`invalid script path: ${path}`);
  }
}

function frozenRecord<T extends object>(record: Record<string, T>) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(record).map(([key, value]) => [
        key,
        Object.freeze({ ...value }),
      ]),
    ),
  ) as Readonly<Record<string, Readonly<T>>>;
}

export function parseBootCatalog(input: unknown): BootCatalog {
  const result = catalogInputSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid Spore boot catalog: ${issueText(result.error)}`);
  }

  const parsed = result.data;
  try {
    assertServerOrigin(parsed.serverOrigin);

    for (const id of Object.keys(parsed.profiles)) {
      assertStableProfileId(id);
    }
    for (const path of Object.keys(parsed.scripts)) {
      assertSafeScriptPath(path);
    }

    if (
      parsed.defaultProfile !== null &&
      parsed.profiles[parsed.defaultProfile] === undefined
    ) {
      throw new Error(
        `defaultProfile references missing profile: ${parsed.defaultProfile}`,
      );
    }

    const normalizedHosts: Record<string, BootHost> = {};
    for (const [rawMac, host] of Object.entries(parsed.hosts)) {
      let normalizedMac: string;
      try {
        normalizedMac = normalizeMac(rawMac);
      } catch {
        throw new Error(`invalid host MAC address: ${rawMac}`);
      }
      if (normalizedHosts[normalizedMac] !== undefined) {
        throw new Error(`duplicate MAC after normalization: ${normalizedMac}`);
      }
      if (host.profile && parsed.profiles[host.profile] === undefined) {
        throw new Error(
          `host ${normalizedMac} references missing profile: ${host.profile}`,
        );
      }
      normalizedHosts[normalizedMac] = host;
    }

    const nativeBootTargets: Record<string, NativeBootTarget> = {};
    for (const [id, target] of Object.entries(parsed.nativeBootTargets)) {
      assertStableProfileId(id);
      let macAddress: string;
      try {
        macAddress = normalizeMac(target.macAddress);
      } catch {
        throw new Error(
          `invalid native boot target MAC address: ${target.macAddress}`,
        );
      }
      nativeBootTargets[id] = {
        ...target,
        macAddress,
        artifactBaseUrl: `${parsed.serverOrigin}/api/native-boot/${id}`,
      };
    }

    return Object.freeze({
      serverOrigin: parsed.serverOrigin,
      allowUnknownHosts: parsed.allowUnknownHosts,
      defaultProfile: parsed.defaultProfile,
      profiles: frozenRecord(parsed.profiles),
      scripts: frozenRecord(parsed.scripts),
      hosts: frozenRecord(normalizedHosts),
      nativeBootTargets: frozenRecord(nativeBootTargets),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Spore boot catalog: ${message}`, { cause: error });
  }
}

const catalogCache = new Map<string, BootCatalog>();

export function loadBootCatalog(
  path = process.env.SPORE_CATALOG_FILE,
): BootCatalog {
  if (!path) {
    throw new Error('SPORE_CATALOG_FILE must name the boot catalog JSON file');
  }
  const cached = catalogCache.get(path);
  if (cached) return cached;

  let input: unknown;
  try {
    input = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read Spore boot catalog at ${path}`, {
      cause: error,
    });
  }

  const catalog = parseBootCatalog(input);
  catalogCache.set(path, catalog);
  return catalog;
}

export function getOriginInfo(catalog: Pick<BootCatalog, 'serverOrigin'>): {
  baseUrl: string;
  serverIp: string;
} {
  const url = new URL(catalog.serverOrigin);
  return { baseUrl: url.href.replace(/\/$/, ''), serverIp: url.hostname };
}
