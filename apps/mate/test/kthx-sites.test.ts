/** The kthx site-token ledger: the pure fold, and the Secret behind it. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  KthxSites,
  parseSites,
  reconcile,
  type Sites,
  serialize,
} from '../src/kthx-sites.ts';
import { Kube } from '../src/kube.ts';
import { FakeKube } from './fakeapi.ts';
import { RecordingLog } from './support.ts';

const ORIGIN = 'https://kthx.example.test';
const SECRET = 'mate-kthx-sites';

function sites(names: Record<string, string>): Sites {
  return { [ORIGIN]: names };
}

describe('reconcile', () => {
  test('an unchanged file changes nothing', () => {
    const ledger = sites({ blog: 'tok-blog' });
    expect(reconcile(ledger, ledger, ledger)).toEqual(ledger);
  });

  test('a site claimed in the sandbox joins the ledger', () => {
    const stamped = sites({ blog: 'tok-blog' });
    expect(
      reconcile(
        stamped,
        stamped,
        sites({ blog: 'tok-blog', shop: 'tok-shop' }),
      ),
    ).toEqual(sites({ blog: 'tok-blog', shop: 'tok-shop' }));
  });

  test('a site the sandbox removed leaves the ledger', () => {
    const stamped = sites({ blog: 'tok-blog', shop: 'tok-shop' });
    expect(reconcile(stamped, stamped, sites({ blog: 'tok-blog' }))).toEqual(
      sites({ blog: 'tok-blog' }),
    );
    // The last site at an origin takes the origin with it.
    expect(reconcile(stamped, stamped, {})).toEqual({});
  });

  // Two threads run at once, and each sandbox sees only what mate stamped
  // into it at its turn's start.
  test('a site another sandbox claimed meanwhile is not removed', () => {
    const stamped = sites({ blog: 'tok-blog' });
    const ledger = sites({ blog: 'tok-blog', shop: 'tok-shop' });
    expect(reconcile(ledger, stamped, stamped)).toEqual(ledger);
    // Nor when this sandbox removed its own.
    expect(reconcile(ledger, stamped, {})).toEqual(sites({ shop: 'tok-shop' }));
  });

  test('a re-claim carries its new token', () => {
    const stamped = sites({ blog: 'tok-old' });
    expect(reconcile(stamped, stamped, sites({ blog: 'tok-new' }))).toEqual(
      sites({ blog: 'tok-new' }),
    );
  });

  // The name was removed here and claimed again elsewhere between stamp and
  // harvest; the newer claim's token is the one that works.
  test('a removal never takes a token it did not stamp', () => {
    expect(
      reconcile(sites({ blog: 'tok-new' }), sites({ blog: 'tok-old' }), {}),
    ).toEqual(sites({ blog: 'tok-new' }));
  });

  test('after a restart nothing was stamped, so every site is new', () => {
    const ledger = sites({ blog: 'tok-blog' });
    expect(reconcile(ledger, {}, sites({ shop: 'tok-shop' }))).toEqual(
      sites({ blog: 'tok-blog', shop: 'tok-shop' }),
    );
  });

  test('origins are folded independently', () => {
    const other = 'https://kthx.dev';
    const stamped = { ...sites({ blog: 'tok-blog' }), [other]: { x: 'tok-x' } };
    expect(
      reconcile(stamped, stamped, {
        ...sites({ blog: 'tok-blog', shop: 'tok-shop' }),
      }),
    ).toEqual({ ...sites({ blog: 'tok-blog', shop: 'tok-shop' }) });
  });

  test('leaves its inputs alone', () => {
    const ledger = sites({ blog: 'tok-blog' });
    const copy = structuredClone(ledger);
    reconcile(ledger, ledger, sites({ shop: 'tok-shop' }));
    expect(ledger).toEqual(copy);
  });
});

describe('the file', () => {
  test('is empty before the CLI writes it', () => {
    expect(parseSites('')).toEqual({});
    expect(parseSites('  \n')).toEqual({});
  });

  test('parses what the CLI writes', () => {
    expect(parseSites(serialize(sites({ blog: 'tok-blog' })))).toEqual(
      sites({ blog: 'tok-blog' }),
    );
  });

  // The tokens in it are not known to be lost, so nothing may be saved over
  // them: the caller must see a throw, never `{}`.
  test('a corrupt file throws rather than reading as empty', () => {
    expect(() => parseSites('{not json')).toThrow();
    expect(() => parseSites('[]')).toThrow('not an object');
    expect(() => parseSites('{"https://kthx.dev": "tok"}')).toThrow(
      'not an object',
    );
    expect(() => parseSites('{"https://kthx.dev": {"blog": 1}}')).toThrow(
      'non-string token',
    );
  });

  test('serialises the same tokens the same way, whatever their order', () => {
    const a = { b: { y: '2', x: '1' }, a: { z: '3' } };
    const b = { a: { z: '3' }, b: { x: '1', y: '2' } };
    expect(serialize(a)).toBe(serialize(b));
    expect(serialize(a).endsWith('\n')).toBe(true);
  });
});

describe('the Secret', () => {
  let fake: FakeKube;
  let log: RecordingLog;
  let ledger: KthxSites;

  beforeEach(() => {
    fake = new FakeKube();
    log = new RecordingLog();
    ledger = new KthxSites({
      kube: new Kube(fake.config()),
      namespace: fake.namespace,
      secret: SECRET,
      log,
    });
  });

  afterEach(() => fake.stop());

  test('an absent key is an empty ledger; an absent Secret is an error', async () => {
    fake.putSecret(SECRET, {});
    expect((await ledger.load()).sites).toEqual({});
    fake.secrets.delete(SECRET);
    await expect(ledger.load()).rejects.toThrow(/not found/);
  });

  test('saves under its own field manager against the revision it read', async () => {
    fake.putSecret(SECRET, { 'sites.json': serialize(sites({ blog: 'tok' })) });
    const before = fake.secretRevision(SECRET);

    await ledger.merge({}, sites({ shop: 'tok-shop' }));
    const [patch] = fake.patches;
    expect(patch?.name).toBe(SECRET);
    expect(patch?.query).toBe('fieldManager=mate');
    expect(patch?.contentType).toBe('application/merge-patch+json');
    expect(patch?.body.metadata).toEqual({ resourceVersion: before });
    expect(parseSites(fake.secretValue(SECRET, 'sites.json') ?? '')).toEqual(
      sites({ blog: 'tok', shop: 'tok-shop' }),
    );
  });

  test('a fold that changes nothing saves nothing', async () => {
    const held = sites({ blog: 'tok' });
    fake.putSecret(SECRET, { 'sites.json': serialize(held) });
    expect(await ledger.merge(held, held)).toEqual(held);
    expect(fake.patches).toEqual([]);
  });

  // Another turn saved between the read and the write.
  test('a stale revision is re-read and folded again', async () => {
    fake.putSecret(SECRET, { 'sites.json': serialize(sites({ blog: 'tok' })) });
    fake.secretMovesAfterRead = 1;

    const saved = await ledger.merge({}, sites({ shop: 'tok-shop' }));
    expect(saved).toEqual(sites({ blog: 'tok', shop: 'tok-shop' }));
    expect(fake.patches).toHaveLength(2);
    expect(
      log.of('kthx sites ledger moved under a save; retrying'),
    ).toHaveLength(1);
  });

  test('gives up after three stale revisions', async () => {
    fake.putSecret(SECRET, {});
    fake.secretMovesAfterRead = 10;
    await expect(ledger.merge({}, sites({ shop: 'tok' }))).rejects.toThrow(
      /modified/,
    );
    expect(fake.patches).toHaveLength(3);
  });
});
