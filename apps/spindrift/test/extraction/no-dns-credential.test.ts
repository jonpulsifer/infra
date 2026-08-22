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
 * credential-shaped name.
 *
 * **A vendor's *default* API root is not, on its own, the same claim.** Every
 * cloud deploy adapter now compiles one in — `cloudrun/index.ts`,
 * `vercel/index.ts` and `static/index.ts` each own a `DEFAULT_ENDPOINT`,
 * applied when a Target's `connection.endpoint` does not override it
 * (`domain/target.ts` says why: none of these ever varied per installation, so
 * treating every one as connection material meant an operator retyped the same
 * constant per project). Cloudflare's is one root for the whole account rather
 * than for one product, so it is owned by the account reader — see
 * {@link OWNS_CLOUDFLARE_DEFAULT_ENDPOINT}.
 *
 * **Reading a zone is not holding one.** The account reader lists zones and the
 * Workers deployer resolves one to its id, because a Worker's custom domain is
 * created by naming the zone it belongs to — and it is created *by the
 * platform*, which then owns the record and its certificate. Nothing here
 * writes a record, and that is the line this file polices at
 * {@link FORBIDDEN}'s `dns_records` pattern: a zone credential is one that can
 * publish, and every record Spindrift is responsible for is still a
 * `DNSEndpoint` the controller publishes.
 *
 * Two exemptions survive: one about naming rather than holding, at
 * {@link NAMES_A_BRAND}, and the one just described.
 */
import { describe, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const APP = join(import.meta.dir, '../..');

/**
 * The one file allowed to compile in Cloudflare's REST API root.
 *
 * A narrower exemption than {@link NAMES_A_BRAND}: only the
 * `api.cloudflare.com` pattern is lifted here, and only for this exact path —
 * every other pattern in {@link FORBIDDEN} still polices this file, and this
 * pattern still polices every other one.
 *
 * **Why this is not the hole §9 exists to close.** `adapters/cloudflare.ts`
 * owns the account's API root, the way `cloudrun/index.ts` and
 * `vercel/index.ts` each own theirs: a vendor's REST root, identical for every
 * account, not connection material. It is the account reader rather than the
 * Pages adapter because Cloudflare puts every product behind that one root, so
 * the constant belongs to the boundary all three surfaces reach and not to
 * whichever of them happened to need it first.
 *
 * What that file does with it is **read**: it lists the account's zones, its
 * Workers subdomain and its Pages projects, so an operator can see what they
 * connected. Listing a zone is not editing one, and the pattern that polices
 * the difference — `dns_records` — is exempted nowhere, in this file or any
 * other. §9's own line, "between naming a host and holding the key to a zone",
 * drawn again at the file level.
 */
const OWNS_CLOUDFLARE_DEFAULT_ENDPOINT = 'src/adapters/cloudflare.ts';

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
const FORBIDDEN: readonly {
  pattern: RegExp;
  why: string;
  /**
   * Paths this pattern does not police. Reserved for `api.cloudflare.com`
   * below — see the comment on {@link OWNS_CLOUDFLARE_DEFAULT_ENDPOINT}.
   */
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
    // The rule the hostname above is only a proxy for. Reading a zone's name
    // and id is how a Worker's custom domain is claimed — the platform then
    // owns the record — and writing one is the thing §9 moved to the
    // controller. No exemption, in any file.
    pattern: /dns_records|\bDNSRecord\b/,
    why: 'publishing a record is the zone credential §9 moved to the controller',
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
    // The exemption is one pattern wide, and the pattern that matters most is
    // not the one exempted: the account reader may say Cloudflare's hostname
    // and still may not publish a record.
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
