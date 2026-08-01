'use client';

import { Trash2, Webhook } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useOptimistic, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { deleteProjectAction, listProjectsAction } from '@/lib/actions';
import { DEFAULT_PROJECT_SLUG, type ProjectSummary } from '@/lib/project-store';
import { projectSlugFromPathname } from '@/lib/slug';
import { cn } from '@/lib/utils';
import { clearCachedWebhooks } from '@/lib/webhook-cache';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from './ui/sidebar';

interface ProjectNavProps {
  initialProjects: ProjectSummary[];
}

export function ProjectNav({ initialProjects }: ProjectNavProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { state } = useSidebar();
  const [isPending, startTransition] = useTransition();
  const [projects, setProjects] = useState(initialProjects);
  const [optimisticProjects, removeOptimistically] = useOptimistic(
    projects,
    (current: ProjectSummary[], slug: string) =>
      current.filter((p) => p.slug !== slug),
  );
  const [projectToDelete, setProjectToDelete] = useState<ProjectSummary | null>(
    null,
  );

  useEffect(() => {
    setProjects(initialProjects);
  }, [initialProjects]);

  const currentSlug = projectSlugFromPathname(pathname);
  const isCollapsed = state === 'collapsed';

  const handleDeleteClick = (e: React.MouseEvent, project: ProjectSummary) => {
    e.preventDefault();
    e.stopPropagation();
    setProjectToDelete(project);
  };

  const handleDeleteConfirm = () => {
    if (!projectToDelete) {
      return;
    }
    const slug = projectToDelete.slug;
    setProjectToDelete(null);

    startTransition(async () => {
      removeOptimistically(slug);
      try {
        await deleteProjectAction(slug);
        clearCachedWebhooks(slug);
        toast.success(`Webhook project "${slug}" deleted`);
        if (currentSlug === slug) {
          router.push('/');
        }
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : 'Failed to delete project',
        );
      }
      const { projects: fresh } = await listProjectsAction();
      setProjects(fresh);
    });
  };

  return (
    <>
      <SidebarMenu>
        {optimisticProjects.length === 0 ? (
          <SidebarMenuItem>
            {!isCollapsed && (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                No projects yet
              </div>
            )}
          </SidebarMenuItem>
        ) : (
          optimisticProjects.map((project) => {
            const isActive = currentSlug === project.slug;
            const isDefault = project.slug === DEFAULT_PROJECT_SLUG;
            return (
              <SidebarMenuItem key={project.slug}>
                <div className="group relative flex items-center w-full">
                  <SidebarMenuButton
                    asChild
                    tooltip={project.slug}
                    className={cn(
                      'transition-all hover:bg-sidebar-accent hover:text-sidebar-accent-foreground flex-1',
                      isActive &&
                        'bg-sidebar-accent text-sidebar-accent-foreground font-medium shadow-sm',
                    )}
                  >
                    <Link href={`/${project.slug}`}>
                      <Webhook className="size-4 shrink-0" />
                      {!isCollapsed && (
                        <>
                          <span className="truncate">{project.slug}</span>
                          {isDefault && (
                            <Badge
                              variant="outline"
                              className="ml-auto text-[10px] px-1 py-0 h-4 border-primary/30 text-primary bg-primary/10"
                            >
                              Default
                            </Badge>
                          )}
                        </>
                      )}
                    </Link>
                  </SidebarMenuButton>
                  {!isDefault && !isCollapsed && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className={cn(
                        'opacity-0 group-hover:opacity-100 transition-opacity ml-1 shrink-0',
                        'hover:bg-destructive/10 hover:text-destructive',
                      )}
                      onClick={(e) => handleDeleteClick(e, project)}
                      title={`Delete webhook project ${project.slug}`}
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  )}
                </div>
              </SidebarMenuItem>
            );
          })
        )}
      </SidebarMenu>

      <Dialog
        open={projectToDelete !== null}
        onOpenChange={(open) => {
          if (!open) {
            setProjectToDelete(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Webhook Project</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete the webhook project "
              {projectToDelete?.slug}"? This action cannot be undone. All
              webhook history for this project will be permanently deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setProjectToDelete(null)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteConfirm}
              disabled={isPending}
            >
              {isPending ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
