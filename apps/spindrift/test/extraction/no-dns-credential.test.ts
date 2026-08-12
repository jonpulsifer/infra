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
 * objects the App chart renders, with the controller doing the publishing.
 * Core does not write them either: `reach` decides the record type, and only
 * the chart holds the address that decision resolves to. The line this test
 * polices is between naming a host and holding the key to a zone.
 *
 * That the claim is not satisfied *vacuously* — by there being no DNS at all —
 * is asserted where the records now live, in
 * `packages/charts/spindrift-app/tests/render.test.ts`.
 *
 * **The line is a zone credential, not a vendor's name.** A deploy adapter for
 * an edge platform's static hosting says that platform's name in its own
 * identifiers, and an account API token scoped to a hosting product cannot edit
 * a zone — so banning the bare brand would have refused a Target on the grounds
 * that it is spelled like a DNS provider. What is banned is what actually holds
 * a zone: a provider SDK, a zone API root written as a literal, and a
 * credential-shaped name. The API root matters twice over — every adapter here
 * reaches its far side through connection material (`StaticConnection.endpoint`
 * and its siblings), so a hostname compiled into core is a bug on its own terms
 * before it is a §9 question.
 *
 * One exemption survives, and it is about naming rather than holding — see
 * {@link NAMES_A_BRAND}.
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
    pattern: /from\s+['"]cloudflare['"]|\bcloudflare-sdk\b|\bcloudflare4\b/i,
    why: 'a provider SDK is the credential §9 removed',
  },
  {
    pattern: /api\.cloudflare\.com/i,
    why: 'an API root is connection material, never a literal in core',
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

const BINARY = /\.(png|jpe?g|gif|ico|webp|avif|woff2?|ttf|otf|pdf|zip|gz)$/i;

/**
 * Where a provider's **name** is the subject rather than a credential.
 *
 * The logo module maps a platform's name to its mark so the UI can render it,
 * which is the one legitimate reason this software says a provider's name out
 * loud: a brand on a button is not a zone token, and the module holds no
 * client, no endpoint, and nothing to authenticate with. A directory rather
 * than a file, because the marks are assets beside their index.
 *
 * Narrow on purpose. Every other path under `src/` is still scanned, and the
 * test below proves the exemption does not extend to a file that merely has
 * "logos" in its name.
 */
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

/** Files reaching for a zone provider. */
function findCredentials(files: readonly SourceFile[]): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    if (file.path.startsWith(NAMES_A_BRAND)) continue;
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
});
