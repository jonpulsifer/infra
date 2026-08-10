/**
 * Connecting a repository: one button, and what Spindrift found behind it.
 *
 * This screen used to ask for seven things — a scope, a kind, a build
 * frontend, a Dockerfile path, a build command, an output directory, and a
 * newline-separated list of watch paths — before it would open a pull request.
 * Every one of those is something §5's detector can read out of the repository,
 * and asking a person to type them made connecting a repo a form about how
 * deployment works rather than a decision about their code.
 *
 * So the shape is: **press Connect, read what it found, confirm.** The scan is
 * `inspectRepository`, which writes nothing; the confirm is
 * `connectRepository`, which detects again against the branch as it is at that
 * moment and opens the pull request. Nothing detection proposes travels through
 * the browser on its way into the repository.
 *
 * Two things stay visible that a shorter screen would have dropped, both §3's
 * disabled-with-reasons grammar:
 *
 * - **A directory Spindrift could not make sense of is listed anyway**, wearing
 *   the sentence saying why. "Nothing here" and "nine things here, seven of
 *   them libraries" are different answers and the screen says which.
 * - **The override is still reachable**, behind a disclosure, because story 32
 *   asks for progressive disclosure rather than for the escape hatch to be
 *   removed.
 */
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  FileCode,
  GitBranch,
  Globe,
  Loader2,
  RefreshCw,
  Server,
  Timer,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ComponentKind } from '../../../domain/desired-state.ts';
import { command, type InputOf, type OutputOf } from '../../client.ts';
import { formatDuration } from '../../components/running-time.tsx';
import type {
  GrantedRepositoryView,
  LinkedRepoView,
  RepositoryConnectorView,
} from '../../model.ts';
import { Badge, Dot } from '../../ui/badge.tsx';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, Eyebrow } from '../../ui/card.tsx';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../../ui/collapsible.tsx';
import { CopyButton } from '../../ui/copy.tsx';
import { Logo } from '../../ui/logo.tsx';
import { cn } from '../../ui/utils.ts';

export interface RepositoryAuthorizationView {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly state: 'waiting' | 'expired' | 'denied' | 'error';
  readonly message?: string;
  /**
   * When GitHub stops accepting this code.
   *
   * Optional because the caller holding this state is free to omit it and every
   * test builds the view by hand — but the server has always sent it, on the
   * first call and on every poll, and the screen spent that whole time telling
   * an operator to type a code with no hint that it dies in fifteen minutes.
   * Absent, the panel simply says nothing about time rather than guessing.
   */
  readonly expiresAt?: string;
}

export interface OpenedRepositoryPullRequest {
  readonly fullName: string;
  readonly number: number;
}

type Inspection = OutputOf<'inspectRepository'>;
type InspectedScope = Inspection['scopes'][number];
type ConnectRepositoryInput = InputOf<'connectRepository'>;

/** What the panel under one repository row is doing. */
type Scan =
  | { readonly state: 'reading' }
  | { readonly state: 'read'; readonly inspection: Inspection }
  | { readonly state: 'failed'; readonly message: string };

export function RepositoryList({
  repos,
  options,
  connector,
  authorization,
  connecting,
  refreshing,
  error,
  openedPullRequest,
  onAuthorize,
  onConnect,
  onRefresh,
  embedded = false,
}: {
  repos: readonly LinkedRepoView[];
  options: readonly GrantedRepositoryView[];
  connector: RepositoryConnectorView;
  authorization: RepositoryAuthorizationView | null;
  connecting: boolean;
  refreshing?: boolean;
  error: string | null;
  openedPullRequest: OpenedRepositoryPullRequest | null;
  onAuthorize: () => void;
  onConnect: (input: ConnectRepositoryInput) => void;
  onRefresh: () => void;
  embedded?: boolean;
}) {
  const controls = (
    <div className="flex flex-wrap justify-end gap-2">
      <Button variant="outline" onClick={onRefresh} disabled={refreshing}>
        <RefreshCw
          aria-hidden="true"
          className={cn('size-4', refreshing && 'animate-spin')}
        />{' '}
        {refreshing ? 'Refreshing...' : 'Refresh'}
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
  );
  const workflow = (
    <>
      {controls}
      <ConnectorCard
        connector={connector}
        authorization={authorization}
        onAuthorize={onAuthorize}
        error={error}
      />

      {connector.state === 'authorized' ? (
        <AvailableRepositories
          options={options}
          connecting={connecting}
          onConnect={onConnect}
        />
      ) : null}

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

      <ConnectedRepositories repos={repos} />
    </>
  );

  if (embedded) {
    const standing = connectorStanding(connector);
    return (
      <section className="grid gap-5 py-6 xl:grid-cols-[240px_minmax(0,1fr)] xl:gap-8">
        <div>
          <div className="flex items-center gap-2">
            <Logo name="github" />
            <h3 className="font-semibold">GitHub</h3>
          </div>
          <Badge className="mt-3" tone={standing.tone}>
            <Dot /> {standing.label}
          </Badge>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            Repository discovery, source events, and build dispatch.
          </p>
        </div>
        <div className="flex min-w-0 flex-col gap-5">{workflow}</div>
      </section>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-5 px-5 py-6">
      <header className="flex flex-wrap items-end gap-4">
        <div>
          <Eyebrow>Repositories</Eyebrow>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            GitHub repositories
          </h1>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
            Pick a repository. Spindrift reads it, writes the configuration it
            implies, and opens one pull request — merging that is what connects
            it.
          </p>
        </div>
        <div className="ml-auto">{controls}</div>
      </header>
      <ConnectorCard
        connector={connector}
        authorization={authorization}
        onAuthorize={onAuthorize}
        error={error}
      />
      {connector.state === 'authorized' ? (
        <AvailableRepositories
          options={options}
          connecting={connecting}
          onConnect={onConnect}
        />
      ) : null}
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
      <ConnectedRepositories repos={repos} />
    </div>
  );
}

/**
 * The connector's state as a sentence and a colour, rather than as its tag.
 *
 * The badge used to print the union member — an operator read the literal word
 * `unauthorized`, which is a name for a case in a type and not something anyone
 * says — and it wore the same amber as `unavailable`. Those two are the furthest
 * apart of the three: `unauthorized` is one button press from done and nothing
 * is wrong, while `unavailable` means this installation holds no keyring and the
 * fix is not on this screen or any other. Same colour for both told the reader
 * that the fixable one was as stuck as the unfixable one.
 */
function connectorStanding(connector: RepositoryConnectorView): {
  readonly label: string;
  readonly tone: 'success' | 'destructive' | 'idle';
} {
  switch (connector.state) {
    case 'authorized':
      return { label: `connected as @${connector.login}`, tone: 'success' };
    case 'unauthorized':
      // Idle, not warning: nothing has gone wrong, this is simply the step
      // before the first one.
      return { label: 'not authorized yet', tone: 'idle' };
    default:
      return { label: 'no keyring', tone: 'destructive' };
  }
}

/**
 * Authorization, which is a different act from connecting anything.
 *
 * Once authorized this collapses to one line. It is a prerequisite, not a
 * destination, and a card that stayed the size of the ceremony would keep
 * spending the top of the screen on a thing that is already done.
 */
function ConnectorCard({
  connector,
  authorization,
  onAuthorize,
  error,
}: {
  connector: RepositoryConnectorView;
  authorization: RepositoryAuthorizationView | null;
  onAuthorize: () => void;
  error: string | null;
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
            <Logo name="github" className="mt-0.5" />
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
              <Logo name="github" className="size-4" /> Authorize GitHub
            </Button>
          ) : (
            <DeviceAuthorization
              authorization={authorization}
              onAuthorize={onAuthorize}
            />
          )}
          {error ? <ErrorMessage message={error} /> : null}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <CheckCircle2 aria-hidden="true" className="size-4 text-success" />
          <p className="text-sm font-semibold">
            Authorized as @{connector.login}
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={onAuthorize}
          >
            Reauthorize
          </Button>
        </div>
        {authorization !== null ? (
          <DeviceAuthorization
            authorization={authorization}
            onAuthorize={onAuthorize}
          />
        ) : null}
        {error ? <ErrorMessage message={error} /> : null}
      </CardContent>
    </Card>
  );
}

/**
 * How much of the code's life is left, ticking.
 *
 * Counting down rather than up, so `RunningTime` is the wrong component and
 * only its formatter is borrowed. The clock is the browser's and the deadline is
 * the server's, which is normally a reason not to compute a duration here — but
 * a device code is a fifteen-minute window and a second of skew inside it is
 * invisible, while showing nothing at all is what leaves an operator typing a
 * code GitHub stopped accepting four minutes ago.
 *
 * `null` when there is no deadline to count, which is the honest answer and not
 * a zero: a panel with no `expiresAt` says nothing about time.
 */
function useRemaining(expiresAt: string | undefined): number | null {
  const ends = expiresAt === undefined ? Number.NaN : Date.parse(expiresAt);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (Number.isNaN(ends)) return;
    // Re-read from the wall clock each tick rather than decrementing, so a
    // throttled background tab comes back with the truth instead of with
    // however many ticks it was allowed.
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ends]);

  return Number.isNaN(ends) ? null : Math.max(0, ends - now);
}

/**
 * The device ceremony, in the four different things it can be doing.
 *
 * All four used to be one red box with a swapped sentence, which made a denial
 * (someone said no, and will have to say yes) look identical to a transport
 * failure (nobody said anything, try again) and to an expiry (nothing is wrong,
 * the code is just old). They fail for different reasons and the reader's next
 * move differs, so they get different words, different tone, and — the part the
 * red box never had — the button that resolves them, in place.
 */
function DeviceAuthorization({
  authorization,
  onAuthorize,
}: {
  authorization: RepositoryAuthorizationView;
  onAuthorize: () => void;
}) {
  const remaining = useRemaining(authorization.expiresAt);

  if (authorization.state !== 'waiting' || remaining === 0) {
    const state = remaining === 0 ? 'expired' : authorization.state;
    const outcome =
      state === 'denied'
        ? {
            tone: 'destructive' as const,
            title: 'GitHub declined the authorization',
            detail:
              'The account that opened the code refused it. A new code will ask again.',
          }
        : state === 'expired'
          ? {
              tone: 'warning' as const,
              title: 'That code expired',
              detail:
                'Device codes are short-lived. Nothing is wrong — take a new one and enter it while the countdown runs.',
            }
          : {
              tone: 'destructive' as const,
              title: 'GitHub did not answer the authorization',
              detail:
                'The ceremony stopped before GitHub said yes or no. Nothing was stored.',
            };
    return (
      <div
        className={cn(
          'rounded-md border px-3 py-2.5',
          outcome.tone === 'warning'
            ? 'border-warning/40 bg-warning-soft'
            : 'border-destructive/40 bg-destructive-soft',
        )}
      >
        <p className="text-sm font-semibold">{outcome.title}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {authorization.message ?? outcome.detail}
        </p>
        <Button
          size="sm"
          variant="outline"
          className="mt-3"
          onClick={onAuthorize}
        >
          Get a new code
        </Button>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-primary/40 bg-accent px-4 py-3">
      <p className="text-sm font-semibold">Enter this code in GitHub</p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <p className="font-mono text-2xl font-semibold tracking-[0.2em]">
          {authorization.userCode}
        </p>
        <CopyButton value={authorization.userCode} label="device code" />
        {remaining === null ? null : (
          <span className="text-xs tabular-nums text-muted-foreground">
            expires in {formatDuration(remaining)}
          </span>
        )}
      </div>
      <Button asChild className="mt-3">
        <a
          href={authorization.verificationUri}
          target="_blank"
          rel="noopener noreferrer"
        >
          Continue in GitHub <ExternalLink aria-hidden="true" />
        </a>
      </Button>
      {/* The poll is real and silent; a reader watching a static panel has no
          way to tell it apart from a page that gave up. */}
      <p
        role="status"
        className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground"
      >
        <Loader2
          aria-hidden="true"
          className="size-3 motion-safe:animate-spin"
        />
        checking with GitHub… this page continues on its own once the App is
        approved.
      </p>
    </div>
  );
}

/** Everything the installation grants, each one row and one button. */
function AvailableRepositories({
  options,
  connecting,
  onConnect,
}: {
  options: readonly GrantedRepositoryView[];
  connecting: boolean;
  onConnect: (input: ConnectRepositoryInput) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);

  if (options.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <p className="text-sm text-muted-foreground">
            This App installation exposes no repositories. Select one in GitHub,
            then refresh.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <section className="flex flex-col gap-2">
      <Eyebrow>Available on this installation</Eyebrow>
      <Card className="divide-y divide-border">
        {options.map((option) => (
          <RepositoryRow
            key={option.repositoryId}
            option={option}
            open={open === option.fullName}
            connecting={connecting}
            onToggle={() =>
              setOpen((current) =>
                current === option.fullName ? null : option.fullName,
              )
            }
            onConnect={onConnect}
          />
        ))}
      </Card>
    </section>
  );
}

/**
 * One repository, and the scan that opens under it.
 *
 * The scan starts when the row opens rather than on a second press. A screen
 * that made you click Connect and then click Scan would be a screen with two
 * buttons for one intention, and the read is free — nothing is written until
 * the confirm at the bottom of the panel.
 */
function RepositoryRow({
  option,
  open,
  connecting,
  onToggle,
  onConnect,
}: {
  option: GrantedRepositoryView;
  open: boolean;
  connecting: boolean;
  onToggle: () => void;
  onConnect: (input: ConnectRepositoryInput) => void;
}) {
  const [scan, setScan] = useState<Scan | null>(null);

  const toggle = () => {
    onToggle();
    if (!open && scan === null) {
      setScan({ state: 'reading' });
      command('inspectRepository', { fullName: option.fullName })
        .then((result) => {
          setScan(
            result.ok
              ? { state: 'read', inspection: result.value }
              : { state: 'failed', message: result.failure.message },
          );
        })
        .catch((cause: unknown) => {
          setScan({
            state: 'failed',
            message: cause instanceof Error ? cause.message : 'the read failed',
          });
        });
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <GitBranch
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground"
        />
        <span className="font-mono text-sm font-medium">{option.fullName}</span>
        <span className="font-mono text-xs text-muted-foreground">
          {option.defaultBranch}
        </span>
        {option.rowExists ? <Badge tone="success">connected</Badge> : null}
        <Button
          size="sm"
          variant={open ? 'ghost' : 'outline'}
          className="ml-auto"
          onClick={toggle}
        >
          {open ? 'Cancel' : option.rowExists ? 'Reconnect' : 'Connect'}
        </Button>
      </div>

      {open ? (
        <div className="border-t border-border-soft bg-secondary/40 px-4 py-4">
          <ScanPanel
            scan={scan}
            fullName={option.fullName}
            connecting={connecting}
            onConnect={onConnect}
          />
        </div>
      ) : null}
    </div>
  );
}

function ScanPanel({
  scan,
  fullName,
  connecting,
  onConnect,
}: {
  scan: Scan | null;
  fullName: string;
  connecting: boolean;
  onConnect: (input: ConnectRepositoryInput) => void;
}) {
  if (scan === null || scan.state === 'reading') {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 aria-hidden="true" className="size-4 animate-spin" />
        Reading {fullName}…
      </p>
    );
  }

  if (scan.state === 'failed') return <ErrorMessage message={scan.message} />;

  const { inspection } = scan;
  const deployable = inspection.scopes.filter(
    (scope) => scope.outcome === 'detected',
  );
  const passedOver = inspection.scopes.filter(
    (scope) => scope.outcome === 'unsupported',
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="font-mono">{inspection.defaultBranch}</span>
        <span className="font-mono">{inspection.commit.slice(0, 7)}</span>
        <span>
          {deployable.length === 0
            ? 'nothing deployable found'
            : deployable.length === 1
              ? '1 deployable directory'
              : `${deployable.length} deployable directories`}
        </span>
      </div>

      {deployable.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {deployable.map((scope) => (
            <li key={scope.scope}>
              <DetectedScope scope={scope} />
            </li>
          ))}
        </ul>
      ) : null}

      {passedOver.length > 0 ? (
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
            <ChevronRight
              aria-hidden="true"
              className="size-3.5 transition-transform group-data-[state=open]:rotate-90"
            />
            {passedOver.length} directory passed over
            {passedOver.length === 1 ? '' : 's'}
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 flex flex-col gap-1.5">
            {passedOver.map((scope) =>
              scope.outcome === 'unsupported' ? (
                <div
                  key={scope.scope}
                  className="rounded-md border border-border px-3 py-2"
                >
                  <p className="font-mono text-xs font-medium">{scope.scope}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {scope.detail}
                  </p>
                </div>
              ) : null,
            )}
          </CollapsibleContent>
        </Collapsible>
      ) : null}

      {!inspection.canConnect ? (
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-soft px-3 py-2">
          <AlertTriangle
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-warning"
          />
          <p className="text-xs">
            This installation has published no reusable build workflow, so
            repositories cannot be connected until an operator states one.
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={
            connecting || deployable.length === 0 || !inspection.canConnect
          }
          onClick={() => onConnect({ fullName })}
        >
          {connecting ? 'Opening pull request…' : 'Connect repository'}
        </Button>
        <p className="text-xs text-muted-foreground">
          {deployable.length === 0
            ? 'Add a spindrift.yaml or a Dockerfile to the directory you want deployed.'
            : 'Opens one pull request. Nothing takes effect until it merges.'}
        </p>
      </div>
    </div>
  );
}

const KIND_ICON = {
  website: Globe,
  service: Server,
  job: Timer,
} as const satisfies Record<ComponentKind, typeof Globe>;

/** One directory Spindrift knows what to do with, and how it knows. */
function DetectedScope({ scope }: { scope: InspectedScope }) {
  if (scope.outcome !== 'detected') return null;
  const Icon = KIND_ICON[scope.kind];

  return (
    <div className="rounded-md border border-border bg-card px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Check aria-hidden="true" className="size-3.5 text-success" />
        <span className="font-mono text-sm font-medium">{scope.scope}</span>
        <Badge tone="accent">
          <Icon aria-hidden="true" className="size-3" />
          {scope.kind}
        </Badge>
        {scope.configured ? (
          <Badge tone="idle">
            <FileCode aria-hidden="true" className="size-3" />
            spindrift.yaml
          </Badge>
        ) : null}
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">
          {scope.frontend === 'dockerfile' ? scope.dockerfile : 'railpack'}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{scope.reason}</p>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-subtle">
        <span>
          {scope.outputDirectory === null
            ? 'served by a running process'
            : `static files from ${scope.outputDirectory}`}
        </span>
        <span>
          rebuilds on {scope.watchPaths.length}{' '}
          {scope.watchPaths.length === 1 ? 'path' : 'paths'}
        </span>
      </div>
    </div>
  );
}

/**
 * Where a fact about a connected repository lives on the host.
 *
 * The same assumption the opened-pull-request link above already makes, named
 * once so it is visible: this templates the public host. `LinkedRepoView`
 * carries no clone URL, so an installation pointed at its own GitHub is the
 * case this gets wrong — and a commit that is one click away is worth more than
 * a hash that is zero clicks away and useless.
 */
function githubUrl(fullName: string, ...path: readonly string[]): string {
  return `https://github.com/${fullName}/${path.join('/')}`;
}

function ConnectedRepositories({
  repos,
}: {
  repos: readonly LinkedRepoView[];
}) {
  if (repos.length === 0) return null;

  return (
    <section className="flex flex-col gap-2">
      <Eyebrow>
        Connected · {repos.length}{' '}
        {repos.length === 1 ? 'repository' : 'repositories'}
      </Eyebrow>
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
                  <Dot />
                  {repo.health === 'connected'
                    ? 'connected'
                    : 'connection lost'}
                </Badge>
                {repo.lastReconciledSha ? (
                  <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span>reconciled at</span>
                    <a
                      className="font-mono underline underline-offset-2 hover:text-foreground"
                      href={githubUrl(
                        repo.fullName,
                        'commit',
                        repo.lastReconciledSha,
                      )}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={repo.lastReconciledSha}
                    >
                      {repo.lastReconciledSha.slice(0, 7)}
                    </a>
                    <CopyButton value={repo.lastReconciledSha} label="commit" />
                  </span>
                ) : null}
              </div>
              {repo.error ? (
                <div className="flex items-start gap-2 rounded-md border border-destructive bg-destructive-soft px-3 py-2">
                  <AlertTriangle
                    aria-hidden="true"
                    className="mt-0.5 size-4 text-destructive"
                  />
                  <p className="text-sm">{repo.error}</p>
                </div>
              ) : null}
              {/* Still connected, and the commit beside it is older than it
                  looks: listing refreshes every row, and one the host would
                  not answer about says so rather than passing for current. */}
              {repo.staleReason ? (
                <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-warning">
                  <AlertTriangle
                    aria-hidden="true"
                    className="mt-0.5 size-4 text-warning"
                  />
                  <p className="text-sm">
                    This row was not refreshed: {repo.staleReason}
                  </p>
                </div>
              ) : null}
              {repo.appSubpaths.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">
                    Deploying from
                  </span>
                  {/* Each subpath is a directory an App is built out of, and the
                      chip went nowhere. It links at the directory rather than at
                      the App because the read model carries the path and not the
                      App's id — see the note in the batch summary. */}
                  {repo.appSubpaths.map((subpath) => (
                    <a
                      key={subpath}
                      href={githubUrl(
                        repo.fullName,
                        'tree',
                        repo.defaultBranch,
                        subpath === '.' ? '' : subpath,
                      )}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-md border bg-secondary px-2 py-1 font-mono text-xs hover:border-primary/50"
                    >
                      {subpath === '.' ? 'repository root' : subpath}
                      <ExternalLink aria-hidden="true" className="size-3" />
                    </a>
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
    </section>
  );
}

function ErrorMessage({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2 text-sm text-destructive">
      {message}
    </div>
  );
}
