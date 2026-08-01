import type { Webhook } from './types';

/**
 * The one seam between Slingshot and its storage.
 *
 * Everything the app knows about how a project is persisted lives behind this
 * interface: the document shape, the 100-webhook circular buffer, the counters
 * that back the stats pages, and the version markers the polling clients use to
 * avoid re-downloading data they already have.
 *
 * Callers ask for outcomes ("record this webhook") rather than describing
 * writes. That is what lets `recordWebhook` be a single transaction - three
 * separate modules previously wrote this same document, and the ingest path
 * fired two concurrent transactions at it per request.
 *
 * Two adapters satisfy this interface: Firestore in production
 * (`lib/project-store-firestore.ts`) and an in-memory store used by the tests
 * (`lib/project-store-memory.ts`).
 */

/** Circular buffer size. A project keeps at most this many webhooks. */
export const MAX_WEBHOOKS = 100;

/** The project every install starts with, and which cannot be deleted. */
export const DEFAULT_PROJECT_SLUG = 'slingshot';

export interface ProjectSummary {
  slug: string;
  createdAt: number;
}

export interface WebhookFeed {
  webhooks: Webhook[];
  maxSize: number;
}

export interface ProjectStats {
  webhookCount: number;
  lastWebhookTimestamp: number | null;
  updatedAt: number;
}

export interface GlobalStats {
  totalProjects: number;
  totalWebhooks: number;
  updatedAt: number;
}

export interface StatsSnapshot {
  projects: Record<string, ProjectStats>;
  global: GlobalStats;
}

/** A read result carrying the version marker that produced it. */
export interface Versioned<T> {
  data: T;
  etag: string | null;
}

/**
 * The result of a freshness poll: either nothing has moved since `knownEtag`,
 * or here is the new data and the etag that goes with it.
 *
 * This is polling-based staleness detection, not locking. The etag is a
 * timestamp-derived marker written server-side on every write. A client cannot
 * use it to prevent a write, only to skip a download.
 */
export type FeedUpdate<T> =
  | { changed: false }
  | { changed: true; data: T; etag: string | null };

export interface ProjectStore {
  /** Projects, default first, then alphabetical. */
  listProjects(): Promise<ProjectSummary[]>;
  projectExists(slug: string): Promise<boolean>;
  /** Rejects if the slug is taken. */
  createProject(slug: string): Promise<ProjectSummary>;
  /** Rejects for the default project, or if it would leave zero projects. */
  deleteProject(slug: string): Promise<void>;

  /** Append a webhook, evict past the cap, and update counters - atomically. */
  recordWebhook(slug: string, webhook: Webhook): Promise<void>;
  readFeed(slug: string): Promise<Versioned<WebhookFeed>>;
  readFeedIfChanged(
    slug: string,
    knownEtag: string | null | undefined,
  ): Promise<FeedUpdate<WebhookFeed>>;
  clearHistory(slug: string): Promise<void>;

  readStats(): Promise<Versioned<StatsSnapshot>>;
  readStatsIfChanged(
    knownEtag: string | null | undefined,
  ): Promise<FeedUpdate<StatsSnapshot>>;
}

export class ProjectStoreError extends Error {}

export class ProjectNotFoundError extends ProjectStoreError {
  constructor(slug: string) {
    super(`Project ${slug} not found`);
  }
}

export class SlugTakenError extends ProjectStoreError {
  constructor(slug: string) {
    super(`Slug ${slug} already exists`);
  }
}

export const EMPTY_STATS: StatsSnapshot = {
  projects: {},
  global: { totalProjects: 0, totalWebhooks: 0, updatedAt: 0 },
};

/**
 * Sort order used by every adapter: the default project pinned to the top,
 * everything else alphabetical.
 */
export function sortProjects(projects: ProjectSummary[]): ProjectSummary[] {
  const rest = projects
    .filter((p) => p.slug !== DEFAULT_PROJECT_SLUG)
    .sort((a, b) => a.slug.localeCompare(b.slug));
  const preferred = projects.find((p) => p.slug === DEFAULT_PROJECT_SLUG);
  return preferred ? [preferred, ...rest] : rest;
}

/**
 * Given a version marker and a reader, decide whether the caller's etag is
 * stale and return fresh data only when it is. Shared by every adapter so the
 * freshness rule is stated once.
 */
export async function resolveIfChanged<T>(
  knownEtag: string | null | undefined,
  currentEtag: string | null,
  read: () => Promise<Versioned<T>>,
): Promise<FeedUpdate<T>> {
  if (!currentEtag) {
    return { changed: false };
  }
  if (knownEtag && knownEtag === currentEtag) {
    return { changed: false };
  }
  const { data, etag } = await read();
  return { changed: true, data, etag };
}
