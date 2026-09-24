import { cacheTag } from 'next/cache';
import type { ProjectSummary } from './project-store';
import { getProjectStore } from './project-store-firestore';

// Cached because every page's sidebar reads it and an uncached read fails
// prerendering. The actions revalidate the tag after a create or delete.
export async function listProjectsCached(): Promise<ProjectSummary[]> {
  'use cache';
  cacheTag('projects');

  const store = await getProjectStore();
  return store.listProjects();
}
