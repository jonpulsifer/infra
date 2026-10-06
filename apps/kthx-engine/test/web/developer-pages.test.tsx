// The CLI, SDK and MCP pages: static renders of each state, held to the kthx
// sources they describe so a page cannot promise a verb, a member or a tool
// that kthx lacks. Turbo reruns this file on a change to a kthx source it
// reads only when kthx-engine#test.inputs in turbo.json names that source.
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DeveloperSurfaces } from '../../src/commands/developer/surfaces.ts';
import { Screen, titleOf } from '../../src/web/app.tsx';
import { crumbsFor } from '../../src/web/components/breadcrumbs.tsx';
import { paletteItems } from '../../src/web/components/command-palette.tsx';
import {
  CLI_VERBS,
  CliPage,
  CliScreen,
} from '../../src/web/views/developer/cli.tsx';
import {
  IDENTITY_PATH,
  McpPage,
  McpScreen,
  SITE_MCP_TOOLS,
} from '../../src/web/views/developer/mcp.tsx';
import {
  SDK_MEMBERS,
  SdkPage,
  SdkScreen,
} from '../../src/web/views/developer/sdk.tsx';

const KTHX = join(import.meta.dir, '../../../kthx');
const REPO_PACKAGES = join(import.meta.dir, '../../../../packages');

const ORIGIN = 'https://kthx-control.example.test';
const ZONE = 'sites.example.test';

const FULL: DeveloperSurfaces = {
  adminMcp: {
    private: 'https://console.example.test/mcp',
    public: 'https://machine.example.test/mcp',
  },
  kthx: { origin: ORIGIN, zone: ZONE },
};

const BARE: DeveloperSurfaces = {
  adminMcp: { private: null, public: null },
  kthx: null,
};

/** The rendered text, so a sentence split across spans is asserted whole. */
const words = (markup: string) =>
  markup
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

const cli = (surfaces: DeveloperSurfaces) =>
  renderToStaticMarkup(<CliPage surfaces={surfaces} />);
const sdk = (surfaces: DeveloperSurfaces) =>
  renderToStaticMarkup(<SdkPage surfaces={surfaces} />);
const mcp = (surfaces: DeveloperSurfaces) =>
  renderToStaticMarkup(
    <McpPage surfaces={surfaces} onNavigate={() => undefined} />,
  );

describe('the CLI page', () => {
  test('installs from the origin kthx names, and claims a site', () => {
    const text = words(cli(FULL));
    expect(text).toContain(`bun add -g ${ORIGIN}/cli/kthx.tgz`);
    expect(text).toContain(`export KTHX_ORIGIN=${ORIGIN}`);
    expect(text).toContain('kthx init my-site');
    expect(text).toContain('kthx deploy my-site');
    expect(text).toContain(`https://<name>.${ZONE}`);
  });

  test('covers sites.json, keyed by origin, and the update check', () => {
    const text = words(cli(FULL));
    expect(text).toContain('sites.json');
    expect(text).toContain('keys tokens by origin');
    expect(text).toContain('KTHX_NO_UPDATE_CHECK=1');
  });

  test('nuke is the operator’s, on the tailnet identity host', () => {
    const nuke = CLI_VERBS.find((verb) => verb.verb === 'nuke');
    expect(nuke?.does).toMatch(/^Operator only/);
    expect(nuke?.does).toContain('admin login on the tailnet identity host');
  });

  test('every verb is drawn, ls --all included', () => {
    const text = words(cli(FULL));
    for (const { usage } of CLI_VERBS) expect(text).toContain(usage);
    expect(text).toContain('kthx ls --all');
  });

  test("its verbs are exactly the CLI dispatcher's arms", async () => {
    const source = await Bun.file(join(KTHX, 'cli/main.ts')).text();
    const arms = [...source.matchAll(/^\s*case '([a-z-]+)':/gm)].map(
      ([, verb]) => verb ?? '',
    );
    expect(arms.length).toBeGreaterThan(0);
    expect(new Set(CLI_VERBS.map(({ verb }) => verb))).toEqual(new Set(arms));
  });

  test('with no kthx it says so and names no origin', () => {
    const markup = cli(BARE);
    expect(words(markup)).toContain('This installation names no kthx');
    expect(markup).not.toContain('kthx.tgz');
    expect(markup).not.toContain('KTHX_ORIGIN=');
    expect(markup).not.toContain('https://');
  });
});

describe('the SDK page', () => {
  test('one tag, site-only, with no package and no types', () => {
    const text = words(sdk(FULL));
    expect(text).toContain('<script src="/api/sdk.js"></script>');
    expect(text).toContain('works on a kthx site only');
    expect(text).toContain('no npm package');
    expect(text).toContain('no type definitions');
  });

  test('links the reference on the zone', () => {
    expect(sdk(FULL)).toContain(`href="https://${ZONE}/skill.md"`);
  });

  test('its members are exactly what the script assigns to window.kthx', async () => {
    const source = await Bun.file(join(REPO_PACKAGES, 'kthx/sdk.js')).text();
    const assigned = source.match(/window\.kthx = \{([^}]*)\}/)?.[1];
    expect(assigned).toBeDefined();
    expect(SDK_MEMBERS.map(({ name }) => name)).toEqual(
      (assigned ?? '').split(',').map((member) => member.trim()),
    );
    const text = words(sdk(FULL));
    for (const { name } of SDK_MEMBERS) expect(text).toContain(`kthx.${name}`);
  });

  test('with no kthx it links nothing and says so', () => {
    const markup = sdk(BARE);
    expect(markup).not.toContain('skill.md"');
    expect(markup).not.toContain('https://');
    expect(words(markup)).toContain('This installation names no kthx');
  });
});

describe('the MCP page', () => {
  test('both admin addresses, and the add command on the private one', () => {
    const text = words(mcp(FULL));
    expect(text).toContain('https://console.example.test/mcp');
    expect(text).toContain('https://machine.example.test/mcp');
    expect(text).toContain(
      'claude mcp add --transport http kthx https://console.example.test/mcp --header "Authorization: Bearer $TOKEN"',
    );
  });

  test('a public host alone still gets the add command', () => {
    const text = words(
      mcp({
        ...FULL,
        adminMcp: { private: null, public: FULL.adminMcp.public },
      }),
    );
    expect(text).toContain(
      'claude mcp add --transport http kthx https://machine.example.test/mcp',
    );
  });

  test('tokens are minted in Settings › Identity', () => {
    expect(IDENTITY_PATH).toBe('/settings/identity');
    expect(words(mcp(FULL))).toContain('Mint a token in Settings › Identity');
    expect(words(mcp(BARE))).toContain('Mint a token in Settings › Identity');
  });

  test("a site's MCP is on the site, named per site, with its tools", () => {
    const text = words(mcp(FULL));
    expect(text).toContain(`https://<site>.${ZONE}/api/mcp`);
    expect(text).toContain('kthx-<site>');
    expect(text).toContain('sites.json');
    expect(text).toContain('kthx mcp');
    for (const { name } of SITE_MCP_TOOLS) expect(text).toContain(name);
  });

  test('its site tools are exactly the ones kthx lists', async () => {
    const source = await Bun.file(join(KTHX, 'server/mcp.ts')).text();
    const tools = source.slice(source.indexOf('const TOOLS'));
    const names = [...tools.matchAll(/^ {4}name: '([a-z_]+)',$/gm)].map(
      ([, name]) => name ?? '',
    );
    expect(names.length).toBeGreaterThan(0);
    expect(SITE_MCP_TOOLS.map(({ name }) => name)).toEqual(names);
  });

  test('with no host and no kthx it names no address', () => {
    const markup = mcp(BARE);
    expect(markup).not.toContain('https://');
    expect(markup).not.toContain('claude mcp add');
    expect(words(markup)).toContain('This deployment names no host for it');
    expect(words(markup)).toContain('This installation names no kthx');
  });
});

describe('every state names kthx, never the engine', () => {
  for (const [name, render] of [
    ['CLI', cli],
    ['SDK', sdk],
    ['MCP', mcp],
  ] as const) {
    test(name, () => {
      expect(render(FULL)).not.toMatch(/spindrift/i);
      expect(render(BARE)).not.toMatch(/spindrift/i);
    });
  }
});

describe('the routes reach the pages ahead of an App name', () => {
  const navigate = () => undefined;

  test('each path opens its screen', () => {
    expect(Screen({ path: '/cli', onNavigate: navigate }).type).toBe(CliScreen);
    expect(Screen({ path: '/sdk', onNavigate: navigate }).type).toBe(SdkScreen);
    expect(Screen({ path: '/mcp', onNavigate: navigate }).type).toBe(McpScreen);
  });

  test('titles, crumbs and the palette name each page', () => {
    const verbs = paletteItems(null);
    for (const [path, label] of [
      ['/cli', 'CLI'],
      ['/sdk', 'SDK'],
      ['/mcp', 'MCP'],
    ] as const) {
      expect(titleOf(path)).toStartWith(`${label} · `);
      expect(crumbsFor(path)).toEqual([{ label }]);
      expect(verbs.find((item) => item.path === path)?.label).toBe(label);
    }
  });
});
