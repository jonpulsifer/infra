/**
 * The served route table — the file a hand-authored route would actually
 * appear in — and the dependency boundary that keeps the build toolchain out of
 * production.
 *
 * `dispatch.test.ts` asserts over `commandRoutes`, which is generated and so
 * cannot fail the assertion; that test proves the generator is right, not that
 * the server is. The plan's warning is about somewhere else entirely — "watch
 * for the first hand-authored route; that is the drift" — and the place to
 * write one is the table that spreads the generated set alongside the client
 * and the health probe.
 */
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
import { HEALTH_PATH, READY_PATH, webRoutes } from '../../src/web/routes.ts';
import {
  STATUS_PATH,
  type StatusRouteDeps,
} from '../../src/web/status-route.ts';
import { STREAM_PATHS } from '../../src/web/streams.ts';
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

/**
 * Auth deps that would throw if reached. This file asserts over the *shape* of
 * the table, so a handler running here would mean the assertion had gone wrong.
 */
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

/**
 * Webhook deps that would throw if reached, and a secret that is never
 * configured — this file asserts over the *shape* of the table, so a delivery
 * actually reaching `applyWebhookDelivery` here would mean the assertion had
 * gone wrong.
 */
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

/**
 * Bosun deps that would throw if reached, and a secret that is never
 * configured — this file asserts over the *shape* of the table, so a claim
 * actually reaching the outbox here would mean the assertion had gone wrong.
 */
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

/** A stand-in for the client, so this file never depends on a build having run. */
const CLIENT = { '/': new Response('the client document') };

/** Inert like the rest: the setup route's deps are reached only by a request. */
const noGitHubSetup = {
  authenticate: () => {
    throw new Error('a route-table test authenticated a request');
  },
  auth: () => {
    throw new Error('a route-table test reached the GitHub App identity');
  },
};

/** Inert like the rest: the status page reads the manifest only per request. */
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
        UPLOAD_PATH,
        WEBHOOK_PATH,
        ...BOSUN_PATHS,
        GITHUB_SETUP_PATH,
        STATUS_PATH,
      ].sort(),
    );
  });

  test('the hand-authored surface is the probes and auth, and stops there', () => {
    // Everything else traces to a generator: a command name, or a file the
    // build emitted. Auth is generated too — from `AUTH_ACTS` — but it is the
    // one generator whose tuple a person writes by hand, so it is counted here
    // rather than exempted. This is the number that must not grow without
    // somebody editing `routes.ts` and this test together.
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
        UPLOAD_PATH,
        WEBHOOK_PATH,
        ...BOSUN_PATHS,
        GITHUB_SETUP_PATH,
        STATUS_PATH,
      ].sort(),
    );
  });

  test('pre-session acts remain on the closed auth surface', () => {
    // The property §21 rests on. Auth itself gates credential-administration
    // acts; every product route is a command gated by `dispatch.ts`.
    for (const path of AUTH_PATHS) {
      expect(path.startsWith('/internal/auth/')).toBe(true);
    }
    expect(AUTH_PATHS).toHaveLength(AUTH_ACTS.length);
  });

  test('the health probe reaches nothing', async () => {
    // §21: no route may hold domain logic. A constant is the strongest form of
    // that — it cannot consult anything.
    const probe = served[HEALTH_PATH];
    expect(probe).toBeInstanceOf(Response);
    expect(await (probe as Response).clone().text()).toBe('ok\n');
  });

  test('the client is served at the root and nowhere else', () => {
    // The client owns navigation (a hash router), so there is no per-screen
    // route. A second document route would mean the server had started routing
    // screens — which is what makes {@link STATUS_PATH} safe to add: it is a
    // catch-all that serves an App's status page, never this client, and it is
    // reached only by a path the table does not hold.
    expect(served['/']).toBe(CLIENT['/']);
    expect(served[STATUS_PATH]).not.toBe(CLIENT['/']);
  });
});

describe('the production client comes from a built bundle', () => {
  test('a missing bundle is a named failure, not a 404 at request time', async () => {
    // The failure mode this guards is an image built without the build step:
    // the server would come up, answer the probe, and serve nothing. Refusing
    // at boot turns that into a pod that never goes ready.
    await expect(
      bundleRoutes(join(APP, 'dist-does-not-exist')),
    ).rejects.toThrow(BundleMissingError);
  });

  test('every emitted file becomes exactly one route', async () => {
    const dist = join(APP, 'dist');
    const files = await readdir(dist).catch(() => null);
    if (files === null) {
      // `bun test` is run without a build in CI's typecheck job; the assertion
      // above already covers the missing case, and skipping beats asserting
      // against a directory that is legitimately absent.
      return;
    }

    const routes = await bundleRoutes(dist);
    expect(Object.keys(routes)).toHaveLength(files.length);
    // The document is the root; everything else keeps its hashed name, which is
    // what the document's relative `./chunk-….js` references resolve to.
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

describe('the production entry carries no build toolchain', () => {
  /**
   * The claim the Dockerfile depends on: `server.ts` runs with
   * devDependencies absent. An HTML import anywhere in its graph would pull the
   * bundler and Tailwind back in, and it would do so at import time — a
   * `NODE_ENV` check inside the module would be far too late.
   *
   * Checked by reading the graph rather than by uninstalling anything, because
   * the failure is a wrong import, and that is what this reads.
   *
   * The list is what `bun install --production` leaves out, plus the client's
   * own libraries: those end up inside `dist/`, so the server importing one
   * would mean it had started rendering rather than serving.
   */
  const ABSENT_FROM_PRODUCTION = [
    'tailwindcss',
    'bun-plugin-tailwind',
    'drizzle-kit',
    'react',
    'react-dom',
    'lucide-react',
    '@radix-ui/react-slot',
  ];

  /**
   * The module specifiers an entry's graph still reaches for once bundled with
   * `packages: 'external'` — which leaves every package import standing, so
   * what survives is exactly the runtime dependency list.
   *
   * Reading specifiers rather than grepping the whole output matters: the
   * string `index.html` legitimately appears in `bundle.ts` as the name of a
   * file it looks for, and a substring match on `.html` would call that an
   * import.
   */
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
    // The load-bearing one. An HTML import is a bundler directive: it pulls the
    // compile-time toolchain into the graph at import, which no runtime check
    // could undo.
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
    // A sanity check on the two above: a graph that reached nothing at all
    // would pass them for the wrong reason.
    const specifiers = await importsOf('src/web/server.ts');
    expect(specifiers).toContain('zod');
    expect(specifiers.some((s) => s.startsWith('drizzle-orm'))).toBe(true);
  });

  test('and dev.ts is the entry that does', async () => {
    // The mirror: if this ever stops being true, the split has collapsed and
    // the test above is passing for the wrong reason.
    const packageJson = await Bun.file(join(APP, 'package.json')).json();
    expect(packageJson.scripts.dev).toContain('dev.ts');
    expect(packageJson.scripts.start).toContain('server.ts');

    const entry = await Bun.file(join(APP, 'src/web/dev.ts')).text();
    expect(entry).toContain('client/index.html');
  });
});
