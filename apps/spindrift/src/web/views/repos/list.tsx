/**
 * Repository authorization, connection, and durable connection health.
 *
 * GitHub authorization is installation-level; connecting a repository is a
 * second, reviewed act that opens the configuration PR. Keeping those two
 * states visually separate prevents “GitHub can list it” from reading as
 * “Spindrift has adopted it”.
 */
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  GitBranch,
  RefreshCw,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type { InputOf } from '../../client.ts';
import type {
  LinkedRepoView,
  RepositoryConnectorView,
  RepositoryOptionView,
} from '../../model.ts';
import { Badge } from '../../ui/badge.tsx';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, Eyebrow } from '../../ui/card.tsx';
import { Field, Label } from '../../ui/field.tsx';
import { cn } from '../../ui/utils.ts';

export interface RepositoryAuthorizationView {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly state: 'waiting' | 'expired' | 'denied' | 'error';
  readonly message?: string;
}

export interface OpenedRepositoryPullRequest {
  readonly fullName: string;
  readonly number: number;
}

type ConnectRepositoryInput = InputOf<'connectRepository'>;

export function RepositoryList({
  repos,
  options,
  connector,
  authorization,
  connecting,
  error,
  openedPullRequest,
  onAuthorize,
  onConnect,
  onRefresh,
}: {
  repos: readonly LinkedRepoView[];
  options: readonly RepositoryOptionView[];
  connector: RepositoryConnectorView;
  authorization: RepositoryAuthorizationView | null;
  connecting: boolean;
  error: string | null;
  openedPullRequest: OpenedRepositoryPullRequest | null;
  onAuthorize: () => void;
  onConnect: (input: ConnectRepositoryInput) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-5 px-5 py-6">
      <header className="flex flex-wrap items-end gap-4">
        <div>
          <Eyebrow>Repositories</Eyebrow>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            GitHub repositories
          </h1>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
            Authorize GitHub, select an installed repository, then review the
            configuration pull request Spindrift opens.
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" onClick={onRefresh}>
            <RefreshCw aria-hidden="true" className="size-4" /> Refresh
          </Button>
          <Button variant="outline" asChild>
            <a
              href="https://github.com/settings/installations"
              target="_blank"
              rel="noopener noreferrer"
            >
              Manage installation{' '}
              <ExternalLink aria-hidden="true" className="size-3.5" />
            </a>
          </Button>
        </div>
      </header>

      <ConnectorCard
        connector={connector}
        authorization={authorization}
        options={options}
        connecting={connecting}
        error={error}
        openedPullRequest={openedPullRequest}
        onAuthorize={onAuthorize}
        onConnect={onConnect}
      />

      <ConnectedRepositories repos={repos} />
    </div>
  );
}

function ConnectorCard({
  connector,
  authorization,
  options,
  connecting,
  error,
  openedPullRequest,
  onAuthorize,
  onConnect,
}: {
  connector: RepositoryConnectorView;
  authorization: RepositoryAuthorizationView | null;
  options: readonly RepositoryOptionView[];
  connecting: boolean;
  error: string | null;
  openedPullRequest: OpenedRepositoryPullRequest | null;
  onAuthorize: () => void;
  onConnect: (input: ConnectRepositoryInput) => void;
}) {
  if (connector.state === 'unavailable') {
    return (
      <Card className="border-destructive/40">
        <CardContent>
          <p className="font-semibold">GitHub connector unavailable</p>
          <p className="mt-1 text-sm text-muted-foreground">
            This installation has no credential keyring. Add the encrypted
            keyring through the installation Secret before authorizing GitHub.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (connector.state === 'unauthorized') {
    return (
      <Card>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-start gap-3">
            <GitBranch aria-hidden="true" className="mt-0.5 size-5" />
            <div>
              <p className="font-semibold">Authorize the GitHub App</p>
              <p className="mt-1 text-sm text-muted-foreground">
                GitHub will show the repositories selected for this App.
                Spindrift stores the resulting credential encrypted and never
                asks for an installation ID or private-key file.
              </p>
            </div>
          </div>
          {authorization === null ? (
            <Button className="self-start" onClick={onAuthorize}>
              <GitBranch aria-hidden="true" /> Authorize GitHub
            </Button>
          ) : (
            <>
              <DeviceAuthorization authorization={authorization} />
              {authorization.state === 'waiting' ? null : (
                <Button className="self-start" onClick={onAuthorize}>
                  Start again
                </Button>
              )}
            </>
          )}
          {error ? <ErrorMessage message={error} /> : null}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-2">
          <CheckCircle2 aria-hidden="true" className="size-5 text-success" />
          <p className="font-semibold">Authorized as @{connector.login}</p>
          <Badge tone="success">GitHub connected</Badge>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={onAuthorize}
          >
            Reauthorize
          </Button>
        </div>
        {authorization !== null ? (
          <DeviceAuthorization authorization={authorization} />
        ) : null}
        <RepositoryConnectionForm
          options={options}
          connecting={connecting}
          onConnect={onConnect}
        />
        {openedPullRequest ? (
          <div className="rounded-md border border-success/40 bg-success-soft px-3 py-2.5 text-sm">
            Configuration PR opened:{' '}
            <a
              className="font-semibold underline underline-offset-2"
              href={`https://github.com/${openedPullRequest.fullName}/pull/${openedPullRequest.number}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {openedPullRequest.fullName}#{openedPullRequest.number}
            </a>
            . Nothing becomes authoritative until it merges.
          </div>
        ) : null}
        {error ? <ErrorMessage message={error} /> : null}
      </CardContent>
    </Card>
  );
}

function DeviceAuthorization({
  authorization,
}: {
  authorization: RepositoryAuthorizationView;
}) {
  if (authorization.state !== 'waiting') {
    return (
      <ErrorMessage
        message={
          authorization.message ??
          (authorization.state === 'denied'
            ? 'GitHub authorization was denied.'
            : authorization.state === 'expired'
              ? 'The GitHub authorization code expired. Start again.'
              : 'GitHub authorization failed.')
        }
      />
    );
  }
  return (
    <div className="rounded-md border border-primary/40 bg-accent px-4 py-3">
      <p className="text-sm font-semibold">Enter this code in GitHub</p>
      <p className="mt-2 font-mono text-2xl font-semibold tracking-[0.2em]">
        {authorization.userCode}
      </p>
      <Button asChild className="mt-3">
        <a
          href={authorization.verificationUri}
          target="_blank"
          rel="noopener noreferrer"
        >
          Continue in GitHub <ExternalLink aria-hidden="true" />
        </a>
      </Button>
      <p className="mt-2 text-xs text-muted-foreground">
        This page checks automatically after GitHub approves the App.
      </p>
    </div>
  );
}

function RepositoryConnectionForm({
  options,
  connecting,
  onConnect,
}: {
  options: readonly RepositoryOptionView[];
  connecting: boolean;
  onConnect: (input: ConnectRepositoryInput) => void;
}) {
  const [repository, setRepository] = useState(options[0]?.fullName ?? '');
  const [scope, setScope] = useState('.');
  const [kind, setKind] =
    useState<ConnectRepositoryInput['scopes'][number]['kind']>('service');
  const [frontend, setFrontend] = useState<'railpack' | 'dockerfile'>(
    'railpack',
  );
  const [dockerfile, setDockerfile] = useState('Dockerfile');
  const [buildCommand, setBuildCommand] = useState('');
  const [outputDirectory, setOutputDirectory] = useState('');
  const [watchPaths, setWatchPaths] = useState('.');

  useEffect(() => {
    if (!options.some((option) => option.fullName === repository)) {
      setRepository(options[0]?.fullName ?? '');
    }
  }, [options, repository]);

  const submit = () => {
    const watched = watchPaths
      .split(/[\n,]/)
      .map((path) => path.trim())
      .filter(Boolean);
    const build: ConnectRepositoryInput['scopes'][number]['build'] =
      frontend === 'dockerfile'
        ? { frontend, dockerfile }
        : {
            frontend,
            buildCommand: buildCommand.trim() || null,
            outputDirectory: outputDirectory.trim() || null,
          };
    onConnect({
      fullName: repository,
      scopes: [
        {
          scope,
          kind,
          build,
          watchPaths: watched.length > 0 ? watched : [scope],
        },
      ],
    });
  };

  if (options.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        This App installation exposes no repositories. Select one in GitHub,
        then refresh.
      </p>
    );
  }

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="repository">Repository</Label>
          <select
            id="repository"
            value={repository}
            onChange={(event) => setRepository(event.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 font-mono text-sm"
          >
            {options.map((option) => (
              <option key={option.repositoryId} value={option.fullName}>
                {option.fullName}
                {option.connected ? ' (connected)' : ''}
              </option>
            ))}
          </select>
        </div>
        <Field
          name="scope"
          label="Scope"
          value={scope}
          onChange={(event) => setScope(event.target.value)}
          hint="Repository-relative directory; use . for the root."
        />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="kind">Component kind</Label>
          <select
            id="kind"
            value={kind}
            onChange={(event) => setKind(event.target.value as typeof kind)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="service">service</option>
            <option value="website">website</option>
            <option value="job">job</option>
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="frontend">Build frontend</Label>
          <select
            id="frontend"
            value={frontend}
            onChange={(event) =>
              setFrontend(event.target.value as typeof frontend)
            }
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="railpack">Railpack</option>
            <option value="dockerfile">Dockerfile</option>
          </select>
        </div>
        {frontend === 'dockerfile' ? (
          <Field
            name="dockerfile"
            label="Dockerfile"
            value={dockerfile}
            onChange={(event) => setDockerfile(event.target.value)}
          />
        ) : (
          <>
            <Field
              name="build-command"
              label="Build command"
              value={buildCommand}
              onChange={(event) => setBuildCommand(event.target.value)}
              placeholder="Let Railpack choose"
            />
            <Field
              name="output-directory"
              label="Output directory"
              value={outputDirectory}
              onChange={(event) => setOutputDirectory(event.target.value)}
              placeholder="Not set"
            />
          </>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="watch-paths">Watch paths</Label>
        <textarea
          id="watch-paths"
          value={watchPaths}
          onChange={(event) => setWatchPaths(event.target.value)}
          rows={3}
          className="rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
        />
        <p className="text-xs text-muted-foreground">
          One repository-relative path per line or comma.
        </p>
      </div>
      <Button
        className="justify-self-start"
        disabled={connecting || repository === '' || scope.trim() === ''}
        onClick={submit}
      >
        {connecting ? 'Opening pull request…' : 'Open configuration PR'}
      </Button>
    </div>
  );
}

function ConnectedRepositories({
  repos,
}: {
  repos: readonly LinkedRepoView[];
}) {
  if (repos.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <p className="text-sm text-muted-foreground">
            No repositories connected yet.
          </p>
        </CardContent>
      </Card>
    );
  }
  return (
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
              <GitBranch aria-hidden="true" className="size-4" />
              <span className="font-mono text-sm font-semibold">
                {repo.fullName}
              </span>
              <Badge tone="idle">{repo.defaultBranch}</Badge>
              <Badge
                tone={repo.health === 'connected' ? 'success' : 'destructive'}
              >
                {repo.health === 'connected' ? 'connected' : 'connection lost'}
              </Badge>
              {repo.lastReconciledSha ? (
                <span className="ml-auto font-mono text-xs text-muted-foreground">
                  last reconciled {repo.lastReconciledSha}
                </span>
              ) : null}
            </div>
            {repo.health === 'connection_lost' && repo.error ? (
              <div className="flex items-start gap-2 rounded-md border border-destructive bg-destructive-soft px-3 py-2">
                <AlertTriangle
                  aria-hidden="true"
                  className="mt-0.5 size-4 text-destructive"
                />
                <p className="text-sm">{repo.error}</p>
              </div>
            ) : null}
            {repo.appSubpaths.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {repo.appSubpaths.map((subpath) => (
                  <span
                    key={subpath}
                    className="rounded-md border bg-secondary px-2 py-1 font-mono text-xs"
                  >
                    {subpath}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Awaiting the configuration PR merge.
              </p>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function ErrorMessage({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2 text-sm text-destructive">
      {message}
    </div>
  );
}
