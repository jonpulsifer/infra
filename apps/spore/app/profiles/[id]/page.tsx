import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ManagedNotice } from '@/components/managed-notice';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { getReadModel } from '@/lib/read-model';

interface ProfilePageProps {
  params: Promise<{ id: string }>;
}

export default async function ProfilePage({ params }: ProfilePageProps) {
  const { id } = await params;
  const model = await getReadModel();
  const profile = model.profiles.find(
    (candidate) => candidate.id === decodeURIComponent(id),
  );

  if (!profile) notFound();

  const effectiveHosts = model.hosts.filter(
    (host) => host.configured && host.profileId === profile.id,
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button asChild variant="ghost" size="icon">
          <Link href="/profiles" aria-label="Back to profiles">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-mono text-3xl font-bold lowercase">
              {profile.name}
            </h1>
            {profile.isDefault && <Badge variant="spore">default</Badge>}
          </div>
          <p className="font-mono text-muted-foreground">{profile.id}</p>
        </div>
      </div>

      <ManagedNotice />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>iPXE content</CardTitle>
            <CardDescription>
              {profile.description ?? 'catalog-managed boot profile'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="overflow-x-auto rounded-sm bg-muted p-4 text-sm leading-relaxed">
              {profile.content}
            </pre>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>effective hosts</CardTitle>
            <CardDescription>
              {effectiveHosts.length} catalog assignment or default
              {effectiveHosts.length === 1 ? '' : 's'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {effectiveHosts.length === 0 ? (
              <p className="font-mono text-sm text-muted-foreground">
                no host resolves to this profile
              </p>
            ) : (
              <ul className="space-y-3">
                {effectiveHosts.map((host) => (
                  <li key={host.macAddress}>
                    <Link
                      href={`/hosts/${encodeURIComponent(host.macAddress)}`}
                      className="font-mono text-sm text-spore hover:underline"
                    >
                      {host.hostname ?? host.macAddress}
                    </Link>
                    {host.hostname && (
                      <p className="font-mono text-xs text-muted-foreground">
                        {host.macAddress}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
