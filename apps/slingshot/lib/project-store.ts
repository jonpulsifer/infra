import type { Webhook } from './types';

// The storage interface: projects, their webhook buffers, the stats counters
// and the etags polling clients send.

/** A project keeps this many of its newest webhooks. */
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

export interface Versioned<T> {
  data: T;
  etag: string | null;
}

// An etag is a write timestamp. It lets a poll skip an unchanged download and
// never guards a write.
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

  /** Appends, evicts past MAX_WEBHOOKS and updates counters atomically. */
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

export function sortProjects(projects: ProjectSummary[]): ProjectSummary[] {
  const rest = projects
    .filter((p) => p.slug !== DEFAULT_PROJECT_SLUG)
    .sort((a, b) => a.slug.localeCompare(b.slug));
  const preferred = projects.find((p) => p.slug === DEFAULT_PROJECT_SLUG);
  return preferred ? [preferred, ...rest] : rest;
}

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
