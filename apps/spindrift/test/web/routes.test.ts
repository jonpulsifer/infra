// The served route table, where a hand-authored route would appear, and the
// dependency boundary that keeps the build toolchain out of production.
import { describe, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { EnrolmentDeps } from '../../src/auth/enrol.ts';
import type { GatewayDeps } from '../../src/auth/gateway.ts';
import { AUTH_ACTS, authPathFor } from '../../src/auth/routes.ts';
import { commandNames } from '../../src/commands/registry.ts';
import type { Database } from '../../src/db/client.ts';
import { BOSUN_PATHS, type BosunRouteDeps } from '../../src/web/bosun-route.ts';
import { BundleMissingError, bundleRoutes } from '../../src/web/bundle.ts';
import { pathFor } from '../../src/web/dispatch.ts';
import { GITHUB_SETUP_PATH } from '../../src/web/github-setup-route.ts';
import { MCP_PATH } from '../../src/web/mcp-route.ts';
import { HEALTH_PATH, READY_PATH, webRoutes } from '../../src/web/routes.ts';
import {
  STATUS_PATH,
  type StatusRouteDeps,
} from '../../src/web/status-route.ts';
import { ATTEMPT_LOG_TEXT_PATH, STREAM_PATHS } from '../../src/web/streams.ts';
import { UPLOAD_PATH } from '../../src/web/upload.ts';
import {
  WEBHOOK_PATH,
  type WebhookRouteDeps,
} from '../../src/web/webhook-route.ts';

const APP = join(import.meta.dir, '../..');

const noSession = {
  authenticate: async () => ({ kind: 'anonymous' as const }),
  context: () => {
    throw new Error('unreachable in a route-table test');
  },
};

// Every dep below throws if reached: this file asserts only the table's shape.
const noAuth: EnrolmentDeps & GatewayDeps = {
  db: new Proxy(
    {},
    {
      get: () => {
        throw new Error('a route-table test reached the database');
      },
    },
  ) as Database,
  clock: {
    now: () => {
      throw new Error('a route-table test read the clock');
    },
  },
  relyingParty: {
    id: 'spindrift.example.test',
    name: 'example',
    origin: 'https://spindrift.example.test',
  },
  enrolmentToken: null,
  gateway: null,
};

const noWebhook: WebhookRouteDeps = {
  db: new Proxy(
    {},
    {
      get: () => {
        throw new Error('a route-table test reached the database');
      },
    },
  ) as Database,
  clock: {
    now: () => {
      throw new Error('a route-table test read the clock');
    },
  },
  secret: async () => null,
  current: () => {
    throw new Error('a route-table test read installation state');
  },
};

const noBosun: BosunRouteDeps = {
  db: new Proxy(
    {},
    {
      get: () => {
        throw new Error('a route-table test reached the database');
      },
    },
  ) as Database,
  clock: {
    now: () => {
      throw new Error('a route-table test read the clock');
    },
  },
  secret: null,
};

// A stand-in, so this file never needs a client build.
const CLIENT = { '/': new Response('the client document') };

const noGitHubSetup = {
  authenticate: () => {
    throw new Error('a route-table test authenticated a request');
  },
  auth: () => {
    throw new Error('a route-table test reached the GitHub App identity');
  },
};

const noStatus: StatusRouteDeps = {
  db: noAuth.db,
  current: () => {
    throw new Error('a route-table test read the installation');
  },
};

const served = webRoutes(
  CLIENT,
  noSession,
  noAuth,
  noWebhook,
  noBosun,
  noGitHubSetup,
  noStatus,
  // `/mcp` takes the dispatch deps shape.
  noSession,
);

const AUTH_PATHS = AUTH_ACTS.map(authPathFor);

describe('what the web process serves', () => {
  test('is the client, the probes, auth, and commands — nothing else', () => {
    expect(Object.keys(served).sort()).toEqual(
      [
        ...Object.keys(CLIENT),
        HEALTH_PATH,
        READY_PATH,
        ...AUTH_PATHS,
        ...commandNames.map(pathFor),
        ...STREAM_PATHS,
        ATTEMPT_LOG_TEXT_PATH,
        UPLOAD_PATH,
        WEBHOOK_PATH,
        ...BOSUN_PATHS,
        GITHUB_SETUP_PATH,
        MCP_PATH,
        STATUS_PATH,
      ].sort(),
    );
  });

  test('the hand-authored surface is the probes and auth, and stops there', () => {
    // Auth is generated from `AUTH_ACTS`, a tuple written by hand, so it counts.
    // This list grows only with `routes.ts`.
    const generated = new Set<string>(commandNames.map(pathFor));
    const handAuthored = Object.keys(served).filter(
      (path) => !generated.has(path) && !(path in CLIENT),
    );
    expect(handAuthored.sort()).toEqual(
      [
        HEALTH_PATH,
        READY_PATH,
        ...AUTH_PATHS,
        ...STREAM_PATHS,
        ATTEMPT_LOG_TEXT_PATH,
        UPLOAD_PATH,
        WEBHOOK_PATH,
        ...BOSUN_PATHS,
        GITHUB_SETUP_PATH,
        // The endpoint is hand-authored; its tools come from `commandNames`.
        MCP_PATH,
        STATUS_PATH,
      ].sort(),
    );
  });

  test('pre-session acts remain on the closed auth surface', () => {
    // Auth gates credential acts; every product route is a command gated by `dispatch.ts`.
    for (const path of AUTH_PATHS) {
      expect(path.startsWith('/internal/auth/')).toBe(true);
    }
    expect(AUTH_PATHS).toHaveLength(AUTH_ACTS.length);
  });

  test('the health probe reaches nothing', async () => {
    // A constant `Response` cannot consult anything.
    const probe = served[HEALTH_PATH];
    expect(probe).toBeInstanceOf(Response);
    expect(await (probe as Response).clone().text()).toBe('ok\n');
  });

  test('the client is served at the root and nowhere else', () => {
    // The client routes by hash, so no screen has a server route. `STATUS_PATH`
    // is a catch-all for App status pages and never serves the client.
    expect(served['/']).toBe(CLIENT['/']);
    expect(served[STATUS_PATH]).not.toBe(CLIENT['/']);
  });
});

describe('the production client comes from a built bundle', () => {
  test('a missing bundle is a named failure, not a 404 at request time', async () => {
    // An image built without the build step would answer the probe and serve
    // nothing; refusing at boot keeps that pod from going ready.
    await expect(
      bundleRoutes(join(APP, 'dist-does-not-exist')),
    ).rejects.toThrow(BundleMissingError);
  });

  test('every emitted file becomes exactly one route', async () => {
    const dist = join(APP, 'dist');
    const files = await readdir(dist).catch(() => null);
    if (files === null) {
      // No build has run; the test above covers the missing bundle.
      return;
    }

    const routes = await bundleRoutes(dist);
    expect(Object.keys(routes)).toHaveLength(files.length);
    // The document's relative `./chunk-….js` references resolve to the hashed names.
    expect(routes['/']).toBeDefined();
    for (const file of files.filter((name) => name !== 'index.html')) {
      expect(routes[`/${file}`]).toBeDefined();
    }
  });

  test('hashed assets are immutable and the document is not', async () => {
    const dist = join(APP, 'dist');
    if ((await readdir(dist).catch(() => null)) === null) return;

    const routes = await bundleRoutes(dist);
    expect(routes['/']!.headers.get('cache-control')).toBe('no-cache');

    const asset = Object.entries(routes).find(([path]) => path !== '/');
    expect(asset).toBeDefined();
    expect(asset![1].headers.get('cache-control')).toContain('immutable');
  });
});

// The Dockerfile runs `server.ts` without devDependencies.
describe('the production entry carries no build toolchain', () => {
  // What `bun install --production` leaves out, plus the client's libraries,
  // which belong in `dist/`.
  const ABSENT_FROM_PRODUCTION = [
    'tailwindcss',
    'bun-plugin-tailwind',
    'drizzle-kit',
    'react',
    'react-dom',
    'lucide-react',
    '@radix-ui/react-slot',
  ];

  // `packages: 'external'` leaves every package import standing. Specifiers are
  // parsed, not grepped: `bundle.ts` names `index.html` as a plain string.
  async function importsOf(entry: string): Promise<string[]> {
    const built = await Bun.build({
      entrypoints: [join(APP, entry)],
      target: 'bun',
      packages: 'external',
    });
    expect(built.success).toBe(true);
    const source = await built.outputs[0]!.text();
    return [
      ...source.matchAll(/(?:^|\s)(?:import|export)[^;]*?from\s*"([^"]+)"/gm),
    ]
      .map((match) => match[1]!)
      .concat(
        [...source.matchAll(/(?:^|\s)import\s*"([^"]+)"/gm)].map((m) => m[1]!),
      );
  }

  test('server.ts imports no HTML module', async () => {
    // An HTML import is a bundler directive that pulls the toolchain in at import.
    const specifiers = await importsOf('src/web/server.ts');
    expect(specifiers.filter((s) => s.endsWith('.html'))).toEqual([]);
  });

  test('and no package that production does not install', async () => {
    const specifiers = await importsOf('src/web/server.ts');
    const offenders = specifiers.filter((specifier) =>
      ABSENT_FROM_PRODUCTION.some(
        (dependency) =>
          specifier === dependency || specifier.startsWith(`${dependency}/`),
      ),
    );
    expect(offenders).toEqual([]);
  });

  test('the graph it does have is small and boring', async () => {
    // A graph that reached nothing would pass the two tests above.
    const specifiers = await importsOf('src/web/server.ts');
    expect(specifiers).toContain('zod');
    expect(specifiers.some((s) => s.startsWith('drizzle-orm'))).toBe(true);
  });

  test('and dev.ts is the entry that does', async () => {
    const packageJson = await Bun.file(join(APP, 'package.json')).json();
    expect(packageJson.scripts.dev).toContain('dev.ts');
    expect(packageJson.scripts.start).toContain('server.ts');

    const entry = await Bun.file(join(APP, 'src/web/dev.ts')).text();
    expect(entry).toContain('client/index.html');
  });
});
