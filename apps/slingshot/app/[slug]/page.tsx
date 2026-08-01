import { Webhook as WebhookIcon } from 'lucide-react';
import Link from 'next/link';
import { Suspense } from 'react';
import { LoadingState } from '@/components/loading-state';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { WebhookSection } from '@/components/webhook-section';
import { DEFAULT_PROJECT_SLUG } from '@/lib/project-store';
import { getProjectStore } from '@/lib/project-store-firestore';
import { isReservedSlug } from '@/lib/slug';

export async function generateStaticParams() {
  // Cache Components requires at least one result, so an unreachable Firestore
  // falls back to the default project rather than failing the build.
  const fallback = [{ slug: DEFAULT_PROJECT_SLUG }];
  try {
    const store = await getProjectStore();
    const projects = await store.listProjects();
    return projects.length > 0
      ? projects.map(({ slug }) => ({ slug }))
      : fallback;
  } catch (error) {
    console.warn(
      'Failed to generate static params for projects, falling back to the default project:',
      error,
    );
    return fallback;
  }
}

function ReservedSlug({ slug }: { slug: string }) {
  return (
    <div className="flex flex-1 flex-col gap-4">
      <PageHeader title="Not Found" description="This endpoint is reserved" />
      <Card className="border border-border/50 bg-card">
        <CardContent className="flex flex-col items-center justify-center py-16">
          <div className="rounded-full bg-muted/50 p-6 mb-4">
            <WebhookIcon className="h-16 w-16 text-primary drop-shadow-[0_0_6px_rgba(139,92,246,0.4)]" />
          </div>
          <h3 className="text-xl font-semibold text-foreground mb-2">
            Invalid Endpoint
          </h3>
          <p className="text-sm text-muted-foreground text-center max-w-md mb-6">
            The endpoint <code className="bg-muted px-1 rounded">/{slug}</code>{' '}
            is reserved and cannot be used as a project slug.
          </p>
          <Link href="/">
            <Button>Go Home</Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  if (isReservedSlug(slug)) {
    return <ReservedSlug slug={slug} />;
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4">
      <PageHeader
        title={slug}
        description={`Webhook project • Endpoint: /api/${slug}`}
      />
      <Suspense fallback={<LoadingState label="Loading webhooks..." />}>
        <WebhookSection projectSlug={slug} />
      </Suspense>
    </div>
  );
}
