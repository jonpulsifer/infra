import { FileCode } from 'lucide-react';
import Link from 'next/link';
import { ManagedNotice } from '@/components/managed-notice';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { getReadModel } from '@/lib/read-model';

export default async function ScriptsPage() {
  const { scripts } = await getReadModel();
  const groups = Map.groupBy(
    scripts,
    (script) => script.path.split('/')[0] ?? '(root)',
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-mono text-3xl font-bold lowercase">scripts</h1>
        <p className="font-mono text-muted-foreground">
          chainable iPXE fragments served from the immutable catalog
        </p>
      </div>

      <ManagedNotice />

      {scripts.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center font-mono text-muted-foreground">
            no scripts are present in the generated catalog
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {[...groups.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([group, groupScripts]) => (
              <Card key={group}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <FileCode className="h-5 w-5 text-spore" />
                    {group}
                  </CardTitle>
                  <CardDescription>
                    {groupScripts.length} catalog script
                    {groupScripts.length === 1 ? '' : 's'}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="divide-y divide-border">
                    {groupScripts.map((script) => (
                      <div
                        key={script.path}
                        className="flex flex-col justify-between gap-2 py-3 first:pt-0 sm:flex-row sm:items-center"
                      >
                        <div>
                          <Link
                            href={`/scripts/${script.path
                              .split('/')
                              .map(encodeURIComponent)
                              .join('/')}`}
                            className="font-mono text-sm text-spore hover:underline"
                          >
                            {script.path}
                          </Link>
                          {script.description && (
                            <p className="text-sm text-muted-foreground">
                              {script.description}
                            </p>
                          )}
                        </div>
                        <code className="w-fit rounded-sm bg-muted px-2 py-1 text-xs">
                          /api/scripts/{script.path}
                        </code>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))}
        </div>
      )}
    </div>
  );
}
