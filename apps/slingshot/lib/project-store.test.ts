import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_PROJECT_SLUG,
  MAX_WEBHOOKS,
  ProjectNotFoundError,
  ProjectStoreError,
  SlugTakenError,
  sortProjects,
} from './project-store';
import { InMemoryProjectStore } from './project-store-memory';
import type { Webhook } from './types';

/**
 * These run against the in-memory adapter, but every assertion is about the
 * ProjectStore interface - so they hold for the Firestore adapter too.
 */

function webhook(overrides: Partial<Webhook> = {}): Webhook {
  return {
    id: 'hook-1',
    method: 'POST',
    url: 'https://example.com/api/demo',
    headers: {},
    body: null,
    timestamp: 1,
    direction: 'incoming',
    ...overrides,
  };
}

function newStore() {
  let tick = 0;
  return new InMemoryProjectStore({
    projects: [DEFAULT_PROJECT_SLUG],
    now: () => ++tick,
  });
}

describe('sortProjects', () => {
  test('pins the default project and alphabetises the rest', () => {
    const sorted = sortProjects([
      { slug: 'zebra', createdAt: 0 },
      { slug: 'alpha', createdAt: 0 },
      { slug: DEFAULT_PROJECT_SLUG, createdAt: 0 },
    ]);
    expect(sorted.map((p) => p.slug)).toEqual([
      DEFAULT_PROJECT_SLUG,
      'alpha',
      'zebra',
    ]);
  });

  test('does not invent the default project when it is absent', () => {
    const sorted = sortProjects([{ slug: 'alpha', createdAt: 0 }]);
    expect(sorted.map((p) => p.slug)).toEqual(['alpha']);
  });
});

describe('projects', () => {
  test('createProject rejects a slug that is taken', async () => {
    const store = newStore();
    await store.createProject('demo');
    expect(store.createProject('demo')).rejects.toBeInstanceOf(SlugTakenError);
  });

  test('deleteProject refuses the default project', async () => {
    const store = newStore();
    await store.createProject('demo');
    expect(store.deleteProject(DEFAULT_PROJECT_SLUG)).rejects.toBeInstanceOf(
      ProjectStoreError,
    );
  });

  test('deleteProject refuses to empty the install', async () => {
    const store = new InMemoryProjectStore({ projects: ['only'] });
    expect(store.deleteProject('only')).rejects.toBeInstanceOf(
      ProjectStoreError,
    );
  });

  test('deleteProject reports an unknown slug', async () => {
    const store = newStore();
    expect(store.deleteProject('nope')).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
  });

  test('deleting a project drops it from the stats snapshot', async () => {
    const store = newStore();
    await store.createProject('demo');
    await store.recordWebhook('demo', webhook());
    await store.deleteProject('demo');

    const { data } = await store.readStats();
    expect(data.projects.demo).toBeUndefined();
    expect(data.global.totalProjects).toBe(1);
    expect(data.global.totalWebhooks).toBe(0);
  });
});

describe('recordWebhook', () => {
  test('keeps newest first', async () => {
    const store = newStore();
    await store.recordWebhook(
      DEFAULT_PROJECT_SLUG,
      webhook({ id: 'old', timestamp: 1 }),
    );
    await store.recordWebhook(
      DEFAULT_PROJECT_SLUG,
      webhook({ id: 'new', timestamp: 2 }),
    );

    const { data } = await store.readFeed(DEFAULT_PROJECT_SLUG);
    expect(data.webhooks.map((w) => w.id)).toEqual(['new', 'old']);
  });

  test('evicts past the cap', async () => {
    const store = newStore();
    for (let i = 0; i < MAX_WEBHOOKS + 5; i++) {
      await store.recordWebhook(
        DEFAULT_PROJECT_SLUG,
        webhook({ id: `hook-${i}`, timestamp: i }),
      );
    }

    const { data } = await store.readFeed(DEFAULT_PROJECT_SLUG);
    expect(data.webhooks).toHaveLength(MAX_WEBHOOKS);
    expect(data.webhooks[0].id).toBe(`hook-${MAX_WEBHOOKS + 4}`);
    expect(data.webhooks.some((w) => w.id === 'hook-0')).toBe(false);
  });

  test('the reported count never exceeds the cap', async () => {
    // The regression: the counter used to increment on every ingest while the
    // buffer was trimmed, so webhookCount drifted above the retained count and
    // never came back down.
    const store = newStore();
    for (let i = 0; i < MAX_WEBHOOKS + 25; i++) {
      await store.recordWebhook(
        DEFAULT_PROJECT_SLUG,
        webhook({ id: `hook-${i}`, timestamp: i }),
      );
    }

    const { data: feed } = await store.readFeed(DEFAULT_PROJECT_SLUG);
    const { data: stats } = await store.readStats();
    expect(stats.projects[DEFAULT_PROJECT_SLUG].webhookCount).toBe(
      MAX_WEBHOOKS,
    );
    expect(stats.projects[DEFAULT_PROJECT_SLUG].webhookCount).toBe(
      feed.webhooks.length,
    );
    expect(stats.global.totalWebhooks).toBe(MAX_WEBHOOKS);
  });

  test('global total is the sum of the per-project counts', async () => {
    const store = newStore();
    await store.createProject('demo');
    await store.recordWebhook(DEFAULT_PROJECT_SLUG, webhook({ id: 'a' }));
    await store.recordWebhook('demo', webhook({ id: 'b' }));
    await store.recordWebhook('demo', webhook({ id: 'c', timestamp: 2 }));

    const { data } = await store.readStats();
    const summed = Object.values(data.projects).reduce(
      (total, p) => total + p.webhookCount,
      0,
    );
    expect(data.global.totalWebhooks).toBe(summed);
    expect(summed).toBe(3);
  });
});

describe('clearHistory', () => {
  test('empties the feed and zeroes the counters', async () => {
    const store = newStore();
    await store.recordWebhook(DEFAULT_PROJECT_SLUG, webhook());
    await store.clearHistory(DEFAULT_PROJECT_SLUG);

    const { data: feed } = await store.readFeed(DEFAULT_PROJECT_SLUG);
    const { data: stats } = await store.readStats();
    expect(feed.webhooks).toHaveLength(0);
    expect(stats.projects[DEFAULT_PROJECT_SLUG].webhookCount).toBe(0);
    expect(
      stats.projects[DEFAULT_PROJECT_SLUG].lastWebhookTimestamp,
    ).toBeNull();
    expect(stats.global.totalWebhooks).toBe(0);
  });
});

describe('freshness polling', () => {
  test('reports no change when the caller already has the current etag', async () => {
    const store = newStore();
    await store.recordWebhook(DEFAULT_PROJECT_SLUG, webhook());

    const { etag } = await store.readFeed(DEFAULT_PROJECT_SLUG);
    const update = await store.readFeedIfChanged(DEFAULT_PROJECT_SLUG, etag);
    expect(update.changed).toBe(false);
  });

  test('returns fresh data once a write moves the etag', async () => {
    const store = newStore();
    await store.recordWebhook(
      DEFAULT_PROJECT_SLUG,
      webhook({ id: 'first', timestamp: 1 }),
    );
    const { etag } = await store.readFeed(DEFAULT_PROJECT_SLUG);

    await store.recordWebhook(
      DEFAULT_PROJECT_SLUG,
      webhook({ id: 'second', timestamp: 2 }),
    );

    const update = await store.readFeedIfChanged(DEFAULT_PROJECT_SLUG, etag);
    expect(update.changed).toBe(true);
    if (update.changed) {
      expect(update.data.webhooks[0].id).toBe('second');
      expect(update.etag).not.toBe(etag);
    }
  });

  test('a caller with no etag gets the data', async () => {
    const store = newStore();
    await store.recordWebhook(DEFAULT_PROJECT_SLUG, webhook());

    const update = await store.readFeedIfChanged(DEFAULT_PROJECT_SLUG, null);
    expect(update.changed).toBe(true);
  });

  test('an unknown project reports no change rather than throwing', async () => {
    const store = newStore();
    const update = await store.readFeedIfChanged('nope', null);
    expect(update.changed).toBe(false);
  });

  test('stats polling follows the same rule', async () => {
    const store = newStore();
    await store.recordWebhook(DEFAULT_PROJECT_SLUG, webhook());
    const { etag } = await store.readStats();

    expect((await store.readStatsIfChanged(etag)).changed).toBe(false);

    await store.recordWebhook(
      DEFAULT_PROJECT_SLUG,
      webhook({ id: 'next', timestamp: 2 }),
    );
    expect((await store.readStatsIfChanged(etag)).changed).toBe(true);
  });
});
