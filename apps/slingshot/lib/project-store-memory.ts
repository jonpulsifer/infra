import {
  DEFAULT_PROJECT_SLUG,
  type FeedUpdate,
  MAX_WEBHOOKS,
  ProjectNotFoundError,
  type ProjectStats,
  type ProjectStore,
  ProjectStoreError,
  type ProjectSummary,
  resolveIfChanged,
  SlugTakenError,
  type StatsSnapshot,
  sortProjects,
  type Versioned,
  type WebhookFeed,
} from './project-store';
import type { Webhook } from './types';

/**
 * In-memory adapter for {@link ProjectStore}. This is the second adapter that
 * makes the seam real: the tests exercise the same interface the ingest route
 * and the server actions use, without a Firestore emulator.
 *
 * It mirrors the Firestore adapter's observable behaviour - cap enforcement,
 * counter arithmetic, etag stamping - and nothing else.
 */

interface MemoryProject {
  slug: string;
  createdAt: number;
  webhooks: Webhook[];
  lastWebhookTimestamp: number | null;
  updatedAt: number;
  webhooksUpdatedAt: number;
}

export interface InMemoryProjectStoreOptions {
  /** Seed slugs, created at t=0. */
  projects?: string[];
  /** Injectable clock so tests can make etags move deterministically. */
  now?: () => number;
}

export class InMemoryProjectStore implements ProjectStore {
  private readonly projects = new Map<string, MemoryProject>();
  private metaUpdatedAt = 0;
  private readonly now: () => number;

  constructor(options: InMemoryProjectStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    for (const slug of options.projects ?? []) {
      this.projects.set(slug, {
        slug,
        createdAt: 0,
        webhooks: [],
        lastWebhookTimestamp: null,
        updatedAt: 0,
        webhooksUpdatedAt: 0,
      });
    }
  }

  async listProjects(): Promise<ProjectSummary[]> {
    return sortProjects(
      [...this.projects.values()].map(({ slug, createdAt }) => ({
        slug,
        createdAt,
      })),
    );
  }

  async projectExists(slug: string): Promise<boolean> {
    return this.projects.has(slug);
  }

  async createProject(slug: string): Promise<ProjectSummary> {
    if (this.projects.has(slug)) {
      throw new SlugTakenError(slug);
    }
    const now = this.now();
    this.projects.set(slug, {
      slug,
      createdAt: now,
      webhooks: [],
      lastWebhookTimestamp: null,
      updatedAt: now,
      webhooksUpdatedAt: now,
    });
    this.metaUpdatedAt = now;
    return { slug, createdAt: now };
  }

  async deleteProject(slug: string): Promise<void> {
    if (slug === DEFAULT_PROJECT_SLUG) {
      throw new ProjectStoreError('Cannot delete the default project');
    }
    if (!this.projects.has(slug)) {
      throw new ProjectNotFoundError(slug);
    }
    if (this.projects.size <= 1) {
      throw new ProjectStoreError('Cannot delete the last remaining project');
    }
    this.projects.delete(slug);
    this.metaUpdatedAt = this.now();
  }

  async recordWebhook(slug: string, webhook: Webhook): Promise<void> {
    const now = this.now();
    const project = this.projects.get(slug) ?? {
      slug,
      createdAt: now,
      webhooks: [],
      lastWebhookTimestamp: null,
      updatedAt: now,
      webhooksUpdatedAt: now,
    };

    project.webhooks = [webhook, ...project.webhooks]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, MAX_WEBHOOKS);
    project.lastWebhookTimestamp = webhook.timestamp;
    project.updatedAt = now;
    project.webhooksUpdatedAt = now;

    this.projects.set(slug, project);
    this.metaUpdatedAt = now;
  }

  async readFeed(slug: string): Promise<Versioned<WebhookFeed>> {
    const project = this.projects.get(slug);
    if (!project) {
      return { data: { webhooks: [], maxSize: MAX_WEBHOOKS }, etag: null };
    }
    return {
      data: { webhooks: [...project.webhooks], maxSize: MAX_WEBHOOKS },
      etag: this.feedEtag(project),
    };
  }

  async readFeedIfChanged(
    slug: string,
    knownEtag: string | null | undefined,
  ): Promise<FeedUpdate<WebhookFeed>> {
    const project = this.projects.get(slug);
    if (!project) {
      return { changed: false };
    }
    return resolveIfChanged(knownEtag, this.feedEtag(project), () =>
      this.readFeed(slug),
    );
  }

  async clearHistory(slug: string): Promise<void> {
    const project = this.projects.get(slug);
    if (!project) {
      return;
    }
    const now = this.now();
    project.webhooks = [];
    project.lastWebhookTimestamp = null;
    project.updatedAt = now;
    project.webhooksUpdatedAt = now;
    this.metaUpdatedAt = now;
  }

  async readStats(): Promise<Versioned<StatsSnapshot>> {
    const projects: Record<string, ProjectStats> = {};
    let totalWebhooks = 0;
    for (const project of this.projects.values()) {
      projects[project.slug] = {
        webhookCount: project.webhooks.length,
        lastWebhookTimestamp: project.lastWebhookTimestamp,
        updatedAt: project.updatedAt,
      };
      totalWebhooks += project.webhooks.length;
    }
    return {
      data: {
        projects,
        global: {
          totalProjects: this.projects.size,
          totalWebhooks,
          updatedAt: this.metaUpdatedAt,
        },
      },
      etag: this.metaUpdatedAt ? this.metaUpdatedAt.toString() : null,
    };
  }

  async readStatsIfChanged(
    knownEtag: string | null | undefined,
  ): Promise<FeedUpdate<StatsSnapshot>> {
    const currentEtag = this.metaUpdatedAt
      ? this.metaUpdatedAt.toString()
      : null;
    return resolveIfChanged(knownEtag, currentEtag, () => this.readStats());
  }

  private feedEtag(project: MemoryProject): string | null {
    return project.webhooksUpdatedAt
      ? project.webhooksUpdatedAt.toString()
      : null;
  }
}
