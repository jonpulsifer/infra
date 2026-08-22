/**
 * The status page an App's address answers with before anything serves it.
 *
 * Real `Request`s against the handler `webRoutes` mounts, over real rows: the
 * claim being tested is that a hostname resolves to the right Component, and a
 * fake that answered that question would be the thing under test.
 */
import { describe, expect, test } from 'bun:test';
import {
  apps,
  builds,
  components,
  deploys,
  targets,
} from '../../src/db/schema.ts';
import {
  STATUS_PATH,
  type StatusRouteDeps,
  statusRoutes,
} from '../../src/web/status-route.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { fixtureManifest, targetValues } from '../harness/installation.ts';
import { aDesiredDocument } from '../harness/release.ts';

const database = withIsolatedDatabase();
const manifest = await fixtureManifest();

/** The fixture's first private zone — where a default Component is named. */
const ZONE = 'apps.example.test';

function deps(): StatusRouteDeps {
  return { db: database().db, current: async () => ({ manifest }) };
}

function get(host: string): Promise<Response> {
  return statusRoutes(deps())[STATUS_PATH]!(
    new Request('https://ignored.example.test/', { headers: { host } }),
  );
}

async function seedApp(
  values: { name: string; vanityDomain?: string } & Record<string, unknown>,
) {
  const [app] = await database()
    .db.insert(apps)
    .values({ sourceKind: 'repo', ...values })
    .returning();
  const [component] = await database()
    .db.insert(components)
    .values({ appId: app!.id, name: 'web', kind: 'service' })
    .returning();
  return component!;
}

/** A Deploy in one phase, with the Target and Build chain it requires. */
async function seedDeploy(
  componentId: string,
  phase: 'LIVE' | 'FAILED' | 'APPLYING',
) {
  const [target] = await database()
    .db.insert(targets)
    .values(targetValues())
    .returning();
  const [build] = await database()
    .db.insert(builds)
    .values({
      componentId,
      commit: 'deadbeef',
      targetShape: 'image',
      artifactType: 'image',
    })
    .returning();
  await database()
    .db.insert(deploys)
    .values({
      componentId,
      targetId: target!.id,
      buildId: build!.id,
      phase,
      desired: aDesiredDocument(),
    })
    .returning();
}

describe('which request this page answers', () => {
  test("the control plane's own name is a plain 404, not a status page", async () => {
    // A path the table does not hold, on the console's own hostname. Answering
    // it with a page about an App would be this route claiming a name that is
    // not an App's.
    const response = await get(manifest.controlPlane.hostname);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('not found\n');
  });

  test('a name no Component answers to is a 404 that does not refresh', async () => {
    const response = await get(`nobody-here.${ZONE}`);
    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).toContain('No app here');
    expect(body).not.toContain('http-equiv="refresh"');
  });
});

describe('what an address says about its App', () => {
  test('an App with no Deploy is reserved, and the page follows it', async () => {
    await seedApp({ name: 'demo' });

    const response = await get(`demo-web.${ZONE}`);
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
    const body = await response.text();
    expect(body).toContain('Waiting for a first release');
    expect(body).toContain('http-equiv="refresh"');
  });

  test('the vanity name reaches the same Component as the canonical', async () => {
    await seedApp({ name: 'vain', vanityDomain: 'shiny' });

    const canonical = await get(`vain-web.${ZONE}`);
    const flat = await get(`shiny.${ZONE}`);
    expect(canonical.status).toBe(503);
    expect(flat.status).toBe(503);
    // The page echoes the name it was asked about, so the two bodies differ in
    // exactly that. What must match is the state they report.
    expect(await flat.text()).toContain('Waiting for a first release');
  });

  test('the apex vanity name reaches the same Component as the canonical', async () => {
    // `@` mints as the bare zone (§9, ticket 137): a request for the zone name
    // with no label at all is still this App's Component.
    await seedApp({ name: 'root', vanityDomain: '@' });

    const canonical = await get(`root-web.${ZONE}`);
    const apex = await get(ZONE);
    expect(canonical.status).toBe(503);
    expect(apex.status).toBe(503);
    expect(await apex.text()).toContain('Waiting for a first release');
  });

  test('a port and a capital letter are still the same name', async () => {
    await seedApp({ name: 'shouty' });

    const response = await get(`SHOUTY-WEB.${ZONE.toUpperCase()}:443`);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('Waiting for a first release');
  });

  test('an in-flight Deploy reads as deploying', async () => {
    const component = await seedApp({ name: 'moving' });
    await seedDeploy(component.id, 'APPLYING');

    expect(await (await get(`moving-web.${ZONE}`)).text()).toContain(
      'Deploying',
    );
  });

  test('a failed Deploy says so without saying why', async () => {
    const component = await seedApp({ name: 'broken' });
    await seedDeploy(component.id, 'FAILED');

    const body = await (await get(`broken-web.${ZONE}`)).text();
    expect(body).toContain('The last release failed');
    // The page is served to whoever asks. A reason belongs in the control
    // plane, behind a session.
    expect(body).not.toContain('deadbeef');
  });

  test('a LIVE Deploy reaching this page is reported as unrouted', async () => {
    // The wildcard only carries a name no exact route claimed, so a live
    // Component arriving here means its route is gone. Saying "live" would be
    // the page contradicting the request that reached it.
    const component = await seedApp({ name: 'live' });
    await seedDeploy(component.id, 'LIVE');

    expect(await (await get(`live-web.${ZONE}`)).text()).toContain(
      'Not routed',
    );
  });
});

describe('the page itself', () => {
  test('escapes the name it was asked about', async () => {
    const response = await get('<script>alert(1)</script>.example.test');
    expect(await response.text()).not.toContain('<script>alert(1)</script>');
  });
});
