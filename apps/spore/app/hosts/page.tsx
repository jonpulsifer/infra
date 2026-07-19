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
import { formatBootPolicy, timeAgo } from '@/lib/utils';

export default async function HostsPage() {
  const model = await getReadModel();
  const profileById = new Map(
    model.profiles.map((profile) => [profile.id, profile]),
  );

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-mono text-3xl font-bold tracking-tight lowercase">
          hosts
        </h1>
        <p className="font-mono text-muted-foreground">
          configured hosts joined with runtime boot observations
        </p>
      </div>

      <ManagedNotice>
        Hostnames and profile assignments come from the Nix catalog. First seen,
        last seen, and attempt counts come from SQLite.
      </ManagedNotice>

      <Card>
        <CardHeader>
          <CardTitle>host projection</CardTitle>
          <CardDescription>
            {model.hosts.length} configured or observed host
            {model.hosts.length === 1 ? '' : 's'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {model.hosts.length === 0 ? (
            <p className="font-mono text-sm text-muted-foreground">
              no hosts are configured or observed
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] font-mono">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="pb-3 font-medium">host</th>
                    <th className="pb-3 font-medium">mac address</th>
                    <th className="pb-3 font-medium">profile</th>
                    <th className="pb-3 font-medium">attempts</th>
                    <th className="pb-3 font-medium">last seen</th>
                    <th className="pb-3 font-medium">source</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {model.hosts.map((host) => {
                    const profile = host.profileId
                      ? profileById.get(host.profileId)
                      : undefined;
                    return (
                      <tr key={host.macAddress} className="text-sm">
                        <td className="py-4">
                          <Link
                            href={`/hosts/${encodeURIComponent(host.macAddress)}`}
                            className="text-spore hover:underline"
                          >
                            {host.hostname ?? 'unknown host'}
                          </Link>
                        </td>
                        <td className="py-4 tracking-wide">
                          {host.macAddress}
                        </td>
                        <td className="py-4">
                          {profile ? (
                            <Link
                              href={`/profiles/${encodeURIComponent(profile.id)}`}
                            >
                              <Badge
                                variant={
                                  profile.isDefault ? 'spore' : 'secondary'
                                }
                              >
                                {profile.name}
                              </Badge>
                            </Link>
                          ) : (
                            <Badge variant="outline">
                              {formatBootPolicy(host.effectiveOutcome)}
                            </Badge>
                          )}
                        </td>
                        <td className="py-4">{host.bootCount}</td>
                        <td className="py-4 text-muted-foreground">
                          {timeAgo(host.lastSeen)}
                        </td>
                        <td className="py-4">
                          <Badge
                            variant={host.configured ? 'secondary' : 'outline'}
                          >
                            {host.configured ? 'Git / Nix' : 'observed only'}
                          </Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
