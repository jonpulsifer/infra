import type {
  DocumentData,
  DocumentReference,
  Firestore,
} from '@google-cloud/firestore';
import {
  FIRESTORE_COLLECTION_NAME,
  WEBHOOKS_SUBCOLLECTION_NAME,
} from './constants';
import { getFirestore, isFirestoreUnavailableError } from './firestore-client';
import {
  DEFAULT_PROJECT_SLUG,
  EMPTY_STATS,
  type FeedUpdate,
  type GlobalStats,
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
 * Firestore adapter for {@link ProjectStore}.
 *
 * Document model:
 *   slingshot/{slug}            - the project, its counters, and its version markers
 *   slingshot/{slug}/webhooks/* - the circular buffer
 *   slingshot/_meta             - global counters
 *
 * `webhooksUpdatedAt` is the feed etag; `_meta.updatedAt` is the stats etag.
 * Both are plain millisecond timestamps stamped on every write.
 */

const META_DOC_ID = '_meta';

interface ProjectDoc extends DocumentData {
  slug?: string;
  createdAt?: number;
  webhookCount?: number;
  lastWebhookTimestamp?: number | null;
  updatedAt?: number;
  webhooksUpdatedAt?: number;
  maxSize?: number;
  type?: string;
}

const asNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' ? value : fallback;

export class FirestoreProjectStore implements ProjectStore {
  constructor(private readonly db: Firestore) {}

  private projects() {
    return this.db.collection(FIRESTORE_COLLECTION_NAME);
  }

  private projectRef(slug: string): DocumentReference {
    return this.projects().doc(slug);
  }

  private webhooksRef(slug: string) {
    return this.projectRef(slug).collection(WEBHOOKS_SUBCOLLECTION_NAME);
  }

  private metaRef(): DocumentReference {
    return this.projects().doc(META_DOC_ID);
  }

  private async projectDocs() {
    return this.projects().where('type', '==', 'project').get();
  }

  async listProjects(): Promise<ProjectSummary[]> {
    try {
      const snapshot = await this.projectDocs();
      const projects = snapshot.docs.map((doc) => {
        const data = doc.data() as ProjectDoc;
        return {
          slug: data.slug || doc.id,
          createdAt: asNumber(data.createdAt, 0),
        };
      });
      return sortProjects(projects);
    } catch (error) {
      if (isFirestoreUnavailableError(error)) {
        return [];
      }
      throw error;
    }
  }

  async projectExists(slug: string): Promise<boolean> {
    const snap = await this.projectRef(slug).get();
    if (!snap.exists) {
      return false;
    }
    const data = snap.data() as ProjectDoc;
    return (data.type || 'project') === 'project';
  }

  async createProject(slug: string): Promise<ProjectSummary> {
    const ref = this.projectRef(slug);
    const now = Date.now();

    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) {
        throw new SlugTakenError(slug);
      }
      tx.set(ref, {
        slug,
        createdAt: now,
        webhookCount: 0,
        lastWebhookTimestamp: null,
        updatedAt: now,
        webhooksUpdatedAt: now,
        type: 'project',
        maxSize: MAX_WEBHOOKS,
      });
    });

    await this.refreshProjectCount();
    return { slug, createdAt: now };
  }

  async deleteProject(slug: string): Promise<void> {
    if (slug === DEFAULT_PROJECT_SLUG) {
      throw new ProjectStoreError('Cannot delete the default project');
    }

    const ref = this.projectRef(slug);
    const snap = await ref.get();
    if (!snap.exists) {
      throw new ProjectNotFoundError(slug);
    }

    const all = await this.projectDocs();
    if (all.docs.length <= 1) {
      throw new ProjectStoreError('Cannot delete the last remaining project');
    }

    const removedCount = asNumber((snap.data() as ProjectDoc).webhookCount, 0);

    // Webhooks live in a subcollection, so they have to go first - deleting a
    // document does not delete what is under it.
    const webhooks = await this.webhooksRef(slug).get();
    const batch = this.db.batch();
    for (const doc of webhooks.docs) {
      batch.delete(doc.ref);
    }
    batch.delete(ref);
    await batch.commit();

    await this.adjustGlobalTotals({
      webhookDelta: -removedCount,
      projectDelta: -1,
    });
  }

  /**
   * Append, evict, and count in one transaction.
   *
   * All reads precede all writes because Firestore transactions require it.
   * `webhookCount` is capped at MAX_WEBHOOKS so it keeps matching the number of
   * documents actually retained, which in turn keeps `_meta.totalWebhooks`
   * equal to the sum of the per-project counts.
   */
  async recordWebhook(slug: string, webhook: Webhook): Promise<void> {
    const projectRef = this.projectRef(slug);
    const webhooksRef = this.webhooksRef(slug);
    const metaRef = this.metaRef();

    await this.db.runTransaction(async (tx) => {
      const projectSnap = await tx.get(projectRef);
      const metaSnap = await tx.get(metaRef);
      // Everything older than the newest (MAX - 1) makes room for the one
      // being appended, so the buffer lands at exactly MAX.
      const overflow = await tx.get(
        webhooksRef
          .orderBy('timestamp', 'desc')
          .offset(MAX_WEBHOOKS - 1)
          .limit(50),
      );

      const now = Date.now();
      const projectData = (projectSnap.data() || {}) as ProjectDoc;
      const currentCount = asNumber(projectData.webhookCount, 0);
      const nextCount = Math.min(currentCount + 1, MAX_WEBHOOKS);
      const countDelta = nextCount - currentCount;

      if (!projectSnap.exists) {
        tx.set(projectRef, {
          slug,
          createdAt: now,
          type: 'project',
          maxSize: MAX_WEBHOOKS,
        });
      }

      tx.set(webhooksRef.doc(webhook.id), webhook);
      for (const doc of overflow.docs) {
        tx.delete(doc.ref);
      }

      tx.set(
        projectRef,
        {
          slug,
          type: 'project',
          maxSize: MAX_WEBHOOKS,
          webhookCount: nextCount,
          lastWebhookTimestamp: webhook.timestamp,
          updatedAt: now,
          webhooksUpdatedAt: now,
        },
        { merge: true },
      );

      const metaData = (metaSnap.data() || {}) as GlobalStats;
      tx.set(
        metaRef,
        {
          type: 'meta',
          totalWebhooks: Math.max(
            0,
            asNumber(metaData.totalWebhooks, 0) + countDelta,
          ),
          updatedAt: now,
        },
        { merge: true },
      );
    });
  }

  async readFeed(slug: string): Promise<Versioned<WebhookFeed>> {
    try {
      const projectSnap = await this.projectRef(slug).get();
      const projectData = (projectSnap.data() || {}) as ProjectDoc;

      const webhooksSnap = await this.webhooksRef(slug)
        .orderBy('timestamp', 'desc')
        .limit(MAX_WEBHOOKS)
        .get();

      const webhooks: Webhook[] = webhooksSnap.docs.map((doc) => {
        const data = doc.data() as Webhook;
        return { ...data, direction: data.direction || 'incoming' };
      });

      return {
        data: {
          webhooks,
          maxSize: asNumber(projectData.maxSize, MAX_WEBHOOKS),
        },
        etag: this.feedEtag(projectData),
      };
    } catch (error) {
      if (isFirestoreUnavailableError(error)) {
        return { data: { webhooks: [], maxSize: MAX_WEBHOOKS }, etag: null };
      }
      throw error;
    }
  }

  async readFeedIfChanged(
    slug: string,
    knownEtag: string | null | undefined,
  ): Promise<FeedUpdate<WebhookFeed>> {
    try {
      const snap = await this.projectRef(slug).get();
      if (!snap.exists) {
        return { changed: false };
      }
      const currentEtag = this.feedEtag(snap.data() as ProjectDoc);
      return resolveIfChanged(knownEtag, currentEtag, () =>
        this.readFeed(slug),
      );
    } catch (error) {
      if (isFirestoreUnavailableError(error)) {
        return { changed: false };
      }
      throw error;
    }
  }

  async clearHistory(slug: string): Promise<void> {
    const projectRef = this.projectRef(slug);
    const snap = await projectRef.get();
    const removedCount = snap.exists
      ? asNumber((snap.data() as ProjectDoc).webhookCount, 0)
      : 0;

    const webhooks = await this.webhooksRef(slug).get();
    const batch = this.db.batch();
    for (const doc of webhooks.docs) {
      batch.delete(doc.ref);
    }

    const now = Date.now();
    batch.set(
      projectRef,
      {
        webhookCount: 0,
        lastWebhookTimestamp: null,
        updatedAt: now,
        webhooksUpdatedAt: now,
      },
      { merge: true },
    );
    await batch.commit();

    await this.adjustGlobalTotals({ webhookDelta: -removedCount });
  }

  async readStats(): Promise<Versioned<StatsSnapshot>> {
    try {
      const [metaSnap, projectsSnap] = await Promise.all([
        this.metaRef().get(),
        this.projectDocs(),
      ]);

      const projects: Record<string, ProjectStats> = {};
      for (const doc of projectsSnap.docs) {
        const data = doc.data() as ProjectDoc;
        projects[doc.id] = {
          webhookCount: asNumber(data.webhookCount, 0),
          lastWebhookTimestamp:
            typeof data.lastWebhookTimestamp === 'number'
              ? data.lastWebhookTimestamp
              : null,
          updatedAt: asNumber(data.updatedAt, 0),
        };
      }

      const metaData = (metaSnap.data() || {}) as Partial<GlobalStats>;
      const global: GlobalStats = {
        totalProjects: asNumber(metaData.totalProjects, projectsSnap.size),
        totalWebhooks: asNumber(metaData.totalWebhooks, 0),
        updatedAt: asNumber(metaData.updatedAt, 0),
      };

      return {
        data: { projects, global },
        etag: global.updatedAt ? global.updatedAt.toString() : null,
      };
    } catch (error) {
      if (isFirestoreUnavailableError(error)) {
        return { data: EMPTY_STATS, etag: null };
      }
      throw error;
    }
  }

  async readStatsIfChanged(
    knownEtag: string | null | undefined,
  ): Promise<FeedUpdate<StatsSnapshot>> {
    try {
      const metaSnap = await this.metaRef().get();
      if (!metaSnap.exists) {
        return { changed: false };
      }
      const updatedAt = asNumber(
        (metaSnap.data() as Partial<GlobalStats>).updatedAt,
        0,
      );
      const currentEtag = updatedAt ? updatedAt.toString() : null;
      return resolveIfChanged(knownEtag, currentEtag, () => this.readStats());
    } catch (error) {
      if (isFirestoreUnavailableError(error)) {
        return { changed: false };
      }
      throw error;
    }
  }

  private feedEtag(data: ProjectDoc): string | null {
    return typeof data.webhooksUpdatedAt === 'number'
      ? data.webhooksUpdatedAt.toString()
      : null;
  }

  /**
   * Counter maintenance is best-effort: the stats pages are informational, and
   * a permissions failure here must not fail an ingest or a delete.
   */
  private async adjustGlobalTotals({
    webhookDelta = 0,
    projectDelta = 0,
  }: {
    webhookDelta?: number;
    projectDelta?: number;
  }): Promise<void> {
    if (webhookDelta === 0 && projectDelta === 0) {
      return;
    }
    try {
      const metaRef = this.metaRef();
      await this.db.runTransaction(async (tx) => {
        const snap = await tx.get(metaRef);
        const data = (snap.data() || {}) as Partial<GlobalStats>;
        tx.set(
          metaRef,
          {
            type: 'meta',
            totalWebhooks: Math.max(
              0,
              asNumber(data.totalWebhooks, 0) + webhookDelta,
            ),
            totalProjects: Math.max(
              0,
              asNumber(data.totalProjects, 0) + projectDelta,
            ),
            updatedAt: Date.now(),
          },
          { merge: true },
        );
      });
    } catch (error) {
      if (!isFirestoreUnavailableError(error)) {
        throw error;
      }
    }
  }

  private async refreshProjectCount(): Promise<void> {
    try {
      const snapshot = await this.projectDocs();
      await this.metaRef().set(
        {
          type: 'meta',
          totalProjects: snapshot.size,
          updatedAt: Date.now(),
        },
        { merge: true },
      );
    } catch (error) {
      if (!isFirestoreUnavailableError(error)) {
        throw error;
      }
    }
  }
}

let cachedStore: FirestoreProjectStore | null = null;

/** The store the server actions and the ingest route use. */
export async function getProjectStore(): Promise<ProjectStore> {
  if (!cachedStore) {
    cachedStore = new FirestoreProjectStore(await getFirestore());
  }
  return cachedStore;
}
