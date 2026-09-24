import { Suspense } from 'react';
import { listProjectsCached } from '@/lib/projects-cache';
import { ProjectNav } from './project-nav';
import { ProjectNavSkeleton } from './project-nav-skeleton';
import { SidebarChrome } from './sidebar-chrome';

// The app's sidebar. Its static chrome renders at once and the project list
// streams in behind a skeleton.

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
