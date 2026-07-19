import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ManagedNotice } from '@/components/managed-notice';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { getReadModel } from '@/lib/read-model';

interface ScriptPageProps {
  params: Promise<{ path: string[] }>;
}

export default async function ScriptPage({ params }: ScriptPageProps) {
  const { path } = await params;
  const scriptPath = path.map(decodeURIComponent).join('/');
  const model = await getReadModel();
  const script = model.scripts.find(
    (candidate) => candidate.path === scriptPath,
  );

  if (!script) notFound();

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button asChild variant="ghost" size="icon">
          <Link href="/scripts" aria-label="Back to scripts">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div className="min-w-0">
          <h1 className="break-all font-mono text-2xl font-bold">
            {script.path}
          </h1>
          <p className="text-muted-foreground">
            {script.description ?? 'catalog-managed iPXE script'}
          </p>
        </div>
      </div>

      <ManagedNotice />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>iPXE content</CardTitle>
            <CardDescription>
              served verbatim after template rendering
            </CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="overflow-x-auto rounded-sm bg-muted p-4 text-sm leading-relaxed">
              {script.content}
            </pre>
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>public endpoint</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 font-mono text-xs">
              <code className="block overflow-x-auto rounded-sm bg-muted p-2">
                {model.catalog.serverOrigin}/api/scripts/{script.path}
              </code>
              <code className="block overflow-x-auto rounded-sm bg-muted p-2">
                chain {'{{base_url}}'}/api/scripts/{script.path}
              </code>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>template values</CardTitle>
              <CardDescription>
                resolved by the boot decision module
              </CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="space-y-2 font-mono text-sm">
                {[
                  ['{{mac}}', 'request MAC'],
                  ['{{hostname}}', 'catalog hostname'],
                  ['{{server_ip}}', 'catalog origin host'],
                  ['{{base_url}}', 'catalog origin'],
                ].map(([variable, meaning]) => (
                  <div key={variable} className="flex justify-between gap-4">
                    <code className="rounded-sm bg-muted px-1">{variable}</code>
                    <span className="text-right text-muted-foreground">
                      {meaning}
                    </span>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
