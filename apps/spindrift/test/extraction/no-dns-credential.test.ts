/**
 * Spindrift holds no DNS provider credential (§9).
 *
 * §9: "**Spindrift writes DNS as CRs the DNS controller publishes**, so it holds
 * **no Cloudflare credential** and gets garbage collection free."
 *
 * That is a claim about what the code *does not contain*, and the only way to
 * keep one of those true is to have something fail when it stops being true. A
 * provider SDK is a plausible thing to reach for — it is one import and one
 * token away, and it would work — so this is the grep that notices.
 *
 * It is deliberately separate from `no-literals.test.ts`. That test polices §20's
 * extraction contract: nothing may *name this installation*. This one polices a
 * §9 architecture decision: nothing may *hold a zone credential*, in any
 * installation. A Cloudflare token belonging to somebody else's account would
 * pass the extraction grep and still be exactly the thing §9 ruled out.
 *
 * What it does not claim: that no DNS is written. Plenty is — as `DNSEndpoint`
 * objects, through the cluster API, with the controller doing the publishing.
 * The line is between describing a record and holding the key to a zone.
 */
import { describe, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const APP = join(import.meta.dir, '../..');

/**
 * Ways a DNS provider credential shows up.
 *
 * Two groups, for two different mistakes:
 *
 * - **A provider SDK or API host.** Importing one is the direct route to holding
 *   a credential, and there is no legitimate reason for core to talk to a zone
 *   API when the controller already does.
 * - **A credential-shaped name.** An installation can hold a token without ever
 *   importing an SDK — a raw `fetch` and an environment variable is enough — so
 *   the names such a value would travel under are matched too.
 */
const FORBIDDEN: readonly { pattern: RegExp; why: string }[] = [
  {
    pattern: /\bcloudflare\b/i,
    why: '§9 writes DNS as CRs; core never talks to the zone provider',
  },
  {
    pattern: /api\.cloudflare\.com|\bcloudflare-sdk\b|\bcloudflare4?\b/i,
    why: 'a zone API client is the credential §9 removed',
  },
  {
    pattern: /\broute53\b|\bgoogle-?clouddns\b/i,
    why: 'any zone provider client, not only the one this installation uses',
  },
  {
    pattern: /\b(dns|zone)_?(api)?_?token\b/i,
    why: 'a zone credential, however it is spelled',
  },
];

/**
 * The one file allowed to say the word.
 *
 * `cr.ts` documents *why* there is no Cloudflare client, and a rule that
 * forbids explaining itself is a rule whose reason gets lost. Its exemption is
 * narrow — one file, and the test below proves the scanner still has teeth
 * everywhere else.
 */
const EXPLAINS_ITSELF = new Set(['src/adapters/dns/cr.ts']);

const BINARY = /\.(png|jpe?g|gif|ico|webp|avif|woff2?|ttf|otf|pdf|zip|gz)$/i;

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

/** Files reaching for a zone provider. */
function findCredentials(files: readonly SourceFile[]): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    if (EXPLAINS_ITSELF.has(file.path)) continue;
    for (const { pattern, why } of FORBIDDEN) {
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

  test('DNS is still written — as objects, through the cluster API', async () => {
    // The negative claim must not be satisfied by there being no DNS at all.
    const cr = await Bun.file(join(APP, 'src/adapters/dns/cr.ts')).text();
    expect(cr).toContain('externaldns.k8s.io/v1alpha1');
    expect(cr).toContain('DNSEndpoint');
  });
});

describe('the scanner catches a deliberately dirty file', () => {
  test('an SDK import is found', () => {
    // A detector nobody has seen fail is not a detector.
    const dirty: SourceFile[] = [
      {
        path: 'src/adapters/dns/zone.ts',
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

  test('the exemption is one file, not a directory', () => {
    const dirty: SourceFile[] = [
      {
        path: 'src/adapters/dns/other.ts',
        source: "import Cloudflare from 'cloudflare';\n",
      },
    ];
    expect(findCredentials(dirty)).not.toEqual([]);
  });
});
