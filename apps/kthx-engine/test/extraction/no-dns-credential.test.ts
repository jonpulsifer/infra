/**
 * DNS records are DNSEndpoint objects a controller publishes, so nothing in
 * src/ may hold a zone credential. Naming a vendor or reading a zone is fine.
 */
import { describe, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const APP = join(import.meta.dir, '../..');

// Cloudflare serves every product from one API root, so the account reader
// owns it. Only the api.cloudflare.com pattern is lifted, and only here.
const OWNS_CLOUDFLARE_DEFAULT_ENDPOINT = 'src/adapters/cloudflare.ts';

// A raw fetch and an environment variable need no SDK, so credential-shaped
// names are matched too.
const FORBIDDEN: readonly {
  pattern: RegExp;
  why: string;
  exempt?: readonly string[];
}[] = [
  {
    pattern: /from\s+['"]cloudflare['"]|\bcloudflare-sdk\b|\bcloudflare4\b/i,
    why: 'a provider SDK is the credential §9 removed',
  },
  {
    pattern: /api\.cloudflare\.com/i,
    why: 'an API root is connection material, never a literal in core',
    exempt: [OWNS_CLOUDFLARE_DEFAULT_ENDPOINT],
  },
  {
    pattern: /\broute53\b|\bgoogle-?clouddns\b/i,
    why: 'any zone provider client, not only the one this installation uses',
  },
  {
    // Reading a zone to claim a Worker's custom domain is fine; writing a
    // record is not, in any file.
    pattern: /dns_records|\bDNSRecord\b/,
    why: 'publishing a record is the zone credential §9 moved to the controller',
  },
  {
    pattern: /\b(dns|zone)_?(api)?_?token\b/i,
    why: 'a zone credential, however it is spelled',
  },
];

const BINARY = /\.(png|jpe?g|gif|ico|webp|avif|woff2?|ttf|otf|pdf|zip|gz)$/i;

/** Logo marks name a provider and hold no client, endpoint or token. */
const NAMES_A_BRAND = 'src/web/client/logos/';

interface SourceFile {
  path: string;
  source: string;
}

async function readSource(dir: string): Promise<SourceFile[]> {
  const root = join(APP, dir);
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files: SourceFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || BINARY.test(entry.name)) continue;
    const absolute = join(entry.parentPath, entry.name);
    files.push({
      path: relative(APP, absolute),
      source: await Bun.file(absolute).text(),
    });
  }
  return files;
}

function findCredentials(files: readonly SourceFile[]): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    if (file.path.startsWith(NAMES_A_BRAND)) continue;
    for (const { pattern, why, exempt } of FORBIDDEN) {
      if (exempt?.includes(file.path)) continue;
      if (pattern.test(file.source)) {
        offenders.push(`${file.path}: ${pattern} — ${why}`);
      }
    }
  }
  return offenders;
}

const source = await readSource('src');

describe('§9: no DNS provider credential lives in src/', () => {
  test('nothing reaches for a zone API', () => {
    expect(findCredentials(source)).toEqual([]);
  });

  test('the package declares no DNS provider dependency', async () => {
    const manifest = (await Bun.file(join(APP, 'package.json')).json()) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ];
    // An SDK in `devDependencies` is still an SDK somebody will import.
    expect(
      declared.filter((name) => /cloudflare|route53|clouddns/i.test(name)),
    ).toEqual([]);
  });
});

describe('the scanner catches a deliberately dirty file', () => {
  test('an SDK import is found', () => {
    const dirty: SourceFile[] = [
      {
        path: 'src/adapters/dns/zone.ts',
        source: "import Cloudflare from 'cloudflare';\n",
      },
    ];
    expect(findCredentials(dirty)).not.toEqual([]);
  });

  test('the brand exemption is that directory, not any file naming a logo', () => {
    const dirty: SourceFile[] = [
      {
        path: 'src/web/views/targets/logos.ts',
        source: "import Cloudflare from 'cloudflare';\n",
      },
    ];
    expect(findCredentials(dirty)).not.toEqual([]);
  });

  test('a bare token, with no SDK anywhere, is found', () => {
    const dirty: SourceFile[] = [
      {
        path: 'src/config/manifest.schema.ts',
        source: 'const dnsApiToken = process.env.DNS_API_TOKEN;\n',
      },
    ];
    expect(findCredentials(dirty)).not.toEqual([]);
  });

  test('the Cloudflare API root is legal in the one file that owns the default', () => {
    const clean: SourceFile[] = [
      {
        path: OWNS_CLOUDFLARE_DEFAULT_ENDPOINT,
        source:
          "const CLOUDFLARE_API_ROOT = 'https://api.cloudflare.com/client/v4';\n",
      },
    ];
    expect(findCredentials(clean)).toEqual([]);
  });

  test('and the exemption is that one file, not any file next to it', () => {
    const dirty: SourceFile[] = [
      {
        path: 'src/adapters/deploy/pages/assets.ts',
        source: "const root = 'https://api.cloudflare.com/client/v4';\n",
      },
    ];
    expect(findCredentials(dirty)).not.toEqual([]);
  });

  test('writing a record is caught in the file that may name the root', () => {
    const dirty: SourceFile[] = [
      {
        path: OWNS_CLOUDFLARE_DEFAULT_ENDPOINT,
        source: "await http.json({ path: '/zones/zone-1/dns_records' });\n",
      },
    ];
    expect(findCredentials(dirty)).not.toEqual([]);
  });

  test('and the exemption is that one pattern, not every pattern for that file', () => {
    const dirty: SourceFile[] = [
      {
        path: OWNS_CLOUDFLARE_DEFAULT_ENDPOINT,
        source: "import Cloudflare from 'cloudflare';\n",
      },
    ];
    expect(findCredentials(dirty)).not.toEqual([]);
  });
});
