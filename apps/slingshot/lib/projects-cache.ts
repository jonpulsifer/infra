import { cacheTag } from 'next/cache';
import type { ProjectSummary } from './project-store';
import { getProjectStore } from './project-store-firestore';

/**
 * The project list as read during rendering.
 *
 * Cache Components requires server-component reads to sit inside a cache
 * boundary, and the sidebar renders on every page - without this the list
 * would be refetched on each render and prerendering would fail outright.
 *
 * Tagged `projects`, which is what `revalidateTag('projects')` in
 * `lib/actions.ts` invalidates after a create or delete.
 */
export async function listProjectsCached(): Promise<ProjectSummary[]> {
  'use cache';
  cacheTag('projects');

  const store = await getProjectStore();
  return store.listProjects();
}
