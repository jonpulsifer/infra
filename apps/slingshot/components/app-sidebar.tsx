import { Suspense } from 'react';
import { listProjectsCached } from '@/lib/projects-cache';
import { ProjectNav } from './project-nav';
import { ProjectNavSkeleton } from './project-nav-skeleton';
import { SidebarChrome } from './sidebar-chrome';

/**
 * The app's only sidebar. Renders its static chrome immediately and streams the
 * project list in behind a skeleton.
 */

async function ProjectNavLoader() {
  const projects = await listProjectsCached();
  return <ProjectNav initialProjects={projects} />;
}

export function AppSidebar() {
  return (
    <SidebarChrome>
      <Suspense fallback={<ProjectNavSkeleton />}>
        <ProjectNavLoader />
      </Suspense>
    </SidebarChrome>
  );
}
