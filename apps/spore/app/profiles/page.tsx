import Link from 'next/link';
import { ManagedNotice } from '@/components/managed-notice';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { getReadModel } from '@/lib/read-model';

export default async function ProfilesPage() {
  const { profiles } = await getReadModel();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-mono text-3xl font-bold lowercase">profiles</h1>
        <p className="font-mono text-muted-foreground">
          versioned iPXE entry points with stable catalog IDs
        </p>
      </div>

      <ManagedNotice />

      {profiles.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center font-mono text-muted-foreground">
            no profiles are present in the generated catalog
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {profiles.map((profile) => (
            <Link
              key={profile.id}
              href={`/profiles/${encodeURIComponent(profile.id)}`}
            >
              <Card className="h-full transition-colors hover:bg-accent/50">
                <CardHeader>
                  <div className="flex items-start justify-between gap-3">
                    <CardTitle>{profile.name}</CardTitle>
                    {profile.isDefault && (
                      <Badge variant="spore">default</Badge>
                    )}
                  </div>
                  <CardDescription>
                    {profile.description ?? profile.id}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="mb-3 flex items-center justify-between font-mono text-xs text-muted-foreground">
                    <span>{profile.id}</span>
                    <span>
                      {profile.hostCount} host
                      {profile.hostCount === 1 ? '' : 's'}
                    </span>
                  </div>
                  <pre className="max-h-28 overflow-hidden rounded-sm bg-muted p-3 text-xs">
                    {profile.content.slice(0, 240)}
                    {profile.content.length > 240 ? '…' : ''}
                  </pre>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
