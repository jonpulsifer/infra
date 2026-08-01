import { Loader2 } from 'lucide-react';
import { Suspense } from 'react';
import { DEFAULT_PROJECT_SLUG } from '@/lib/project-store';
import { listProjectsCached } from '@/lib/projects-cache';
import { HowToUseExamples } from './how-to-use-examples';

/**
 * The home page's interactive examples, with the project picker populated from
 * the store. Distinct from `project-nav`, which is the sidebar list - the two
 * previously both exported a component called `ProjectsList`.
 */

async function Examples() {
  const projects = await listProjectsCached();
  const listed =
    projects.length > 0 ? projects : [{ slug: DEFAULT_PROJECT_SLUG }];

  return <HowToUseExamples projects={listed} defaultProject={listed[0].slug} />;
}

function ExamplesSpinner() {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="flex flex-col items-center gap-4">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    </div>
  );
}

export function QuickStartExamples() {
  return (
    <Suspense fallback={<ExamplesSpinner />}>
      <Examples />
    </Suspense>
  );
}
