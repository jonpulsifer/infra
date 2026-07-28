/**
 * The Repositories management view (§20).
 *
 * Shows every repository linked through the GitHub App installation, its
 * connection health, last-reconciled commit, and the App subpaths connected
 * to it. This is the operator surface for managing source connections —
 * adding a repository sends the operator to GitHub's installation settings,
 * and removing one freezes rather than destroys (§20).
 *
 * A lost connection is the loudest thing on the screen: §20 says it stops
 * automatic builds and Git-backed UI edits while keeping existing Deploys
 * alive, so the error and its distinction (suspension vs uninstall vs
 * repository removal) must be readable without clicking anything.
 */
import {
  AlertTriangle,
  ExternalLink,
  GitBranch,
  RefreshCw,
} from 'lucide-react';
import type { LinkedRepoView } from '../../model.ts';
import { Badge } from '../../ui/badge.tsx';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, Eyebrow } from '../../ui/card.tsx';
import { cn } from '../../ui/utils.ts';

export function RepositoryList({
  repos,
}: {
  repos: readonly LinkedRepoView[];
}) {
  return (
    <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-5 px-5 py-6">
      <header className="flex flex-wrap items-end gap-4">
        <div>
          <Eyebrow>Repositories</Eyebrow>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Connected repositories
          </h1>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
            Repositories linked through the GitHub App installation. Spindrift
            watches the default branch and rebuilds when watch paths match.
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          <Button variant="outline">
            <RefreshCw aria-hidden="true" className="size-4" /> Refresh
          </Button>
          <Button variant="outline" asChild>
            <a
              href="https://github.com/settings/installations"
              target="_blank"
              rel="noopener noreferrer"
            >
              Manage in GitHub{' '}
              <ExternalLink aria-hidden="true" className="size-3.5" />
            </a>
          </Button>
        </div>
      </header>

      {repos.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-sm text-muted-foreground">
              No repositories linked. Add repositories to the GitHub App
              installation, then refresh.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {repos.map((repo) => (
            <Card
              key={repo.repositoryId}
              className={cn(
                repo.health === 'connection_lost' && 'border-destructive/40',
              )}
            >
              <CardContent className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-3">
                  <GitBranch
                    aria-hidden="true"
                    className={cn(
                      'size-4',
                      repo.health === 'connected'
                        ? 'text-muted-foreground'
                        : 'text-destructive',
                    )}
                  />
                  <span className="font-mono text-sm font-semibold">
                    {repo.fullName}
                  </span>
                  <Badge tone="idle">{repo.defaultBranch}</Badge>
                  <Badge
                    tone={
                      repo.health === 'connected' ? 'success' : 'destructive'
                    }
                  >
                    {repo.health === 'connected'
                      ? 'connected'
                      : 'connection lost'}
                  </Badge>
                  {repo.lastReconciledSha ? (
                    <span className="ml-auto font-mono text-xs text-muted-foreground">
                      last reconciled {repo.lastReconciledSha}
                    </span>
                  ) : null}
                </div>

                {repo.health === 'connection_lost' && repo.error ? (
                  <div className="flex items-start gap-2.5 rounded-md border border-destructive bg-destructive-soft px-3 py-2.5">
                    <AlertTriangle
                      aria-hidden="true"
                      className="mt-0.5 size-4 shrink-0 text-destructive"
                    />
                    <div>
                      <p className="text-sm font-semibold text-destructive">
                        Connection lost
                      </p>
                      <p className="text-xs text-subtle">{repo.error}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Existing Deploys keep running. Automatic builds and
                        Git-backed UI edits are stopped until access is
                        restored.
                      </p>
                    </div>
                  </div>
                ) : null}

                {repo.appSubpaths.length > 0 ? (
                  <div>
                    <Eyebrow>App subpaths</Eyebrow>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {repo.appSubpaths.map((subpath) => (
                        <span
                          key={subpath}
                          className="inline-flex items-center rounded-md border border-border bg-secondary px-2 py-1 font-mono text-xs"
                        >
                          {subpath}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No Apps connected to this repository yet.
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <div className="rounded-md border border-border bg-secondary px-3 py-2.5 text-xs text-muted-foreground">
        Missing a repository? Add it to the{' '}
        <a
          href="https://github.com/settings/installations"
          target="_blank"
          rel="noopener noreferrer"
          className="font-semibold text-foreground underline underline-offset-2"
        >
          GitHub App installation settings
        </a>
        , then refresh this list. Spindrift stores no GitHub credential — tokens
        are minted on demand from the App's private key.
      </div>
    </div>
  );
}
