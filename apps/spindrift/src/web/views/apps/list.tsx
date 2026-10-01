/**
 * The App list: Apps built here, then the kthx sites, both as Apps. A built
 * row keys, links and deletes by App id, because App names are not unique; a
 * site row keys by `site:<name>` and only opens its read-only workspace. An
 * aside beside it shows the newest Builds and Deploys.
 */
import { ChevronRight, Plus, Search } from 'lucide-react';
import type { ReactNode, RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';
import {
  type AppListItem,
  type AppRowsView,
  type AppRowView,
  appStatusWord,
  isInFlight,
  type SiteListItem,
  siteStatusWord,
  targetName,
} from '../../../commands/views.ts';
import { command } from '../../client.ts';
import {
  type AppDeletionControls,
  DeleteAppButton,
  DeleteAppDialog,
  useAppDeletion,
} from '../../components/delete-app.tsx';
import { ExplorerPageHeader } from '../../components/object-explorer.tsx';
import { AppDot, SiteDot } from '../../components/status.tsx';
import { useRead } from '../../poll.ts';
import { Badge } from '../../ui/badge.tsx';
import { Button } from '../../ui/button.tsx';
import { Kbd } from '../../ui/kbd.tsx';
import { Page } from '../../ui/page.tsx';
import { SkeletonRows } from '../../ui/skeleton.tsx';
import { Timestamp } from '../../ui/timestamp.tsx';
import { notify } from '../../ui/toast.tsx';
import { cn } from '../../ui/utils.ts';
import { type ActivityEntry, activityEntries } from '../operations/activity.ts';
import { LedgerSkeleton, ScreenFailure } from '../screen.tsx';

/** A stored App address may be either a hostname or an absolute HTTP URL. */
export function appHref(url: string): string | null {
  const value = url.trim();
  if (value === '') return null;
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

/** The host a reader scans for, without the scheme kthx prefixes. */
function domainOf(url: string): string {
  const href = appHref(url);
  return href === null ? '—' : href.replace(/^https?:\/\//i, '');
}

/** Target and the release behind the row's status, or `—` when unplaced. */
function appDeployment(app: AppListItem): string {
  if (app.target === 'none') return '—';
  const target = targetName(app.vessel, app.target);
  return app.deployId === undefined
    ? target
    : `${target} · Deploy #${app.deployId}`;
}

/** `held` pins the serving release; it is not a status. */
function siteDeployment(site: SiteListItem): string {
  if (site.release === null) return '—';
  return site.held
    ? `release ${site.release} · held`
    : `release ${site.release}`;
}

/** Everything a row matches on, including the facts it does not print. */
function haystack(row: AppRowView): string {
  if (row.kind === 'site') {
    const { site } = row;
    return `site ${site.name} ${site.url} ${site.owner ?? ''} ${siteDeployment(site)}`.toLowerCase();
  }
  const { app } = row;
  return `app ${app.name} ${app.kind} ${app.target} ${app.vessel} ${app.source} ${app.url} ${app.artifact} ${app.commit ?? ''} ${app.commitMessage ?? ''}`.toLowerCase();
}

/**
 * Every row is an App, so the total counts both kinds; the badges' words name
 * the split.
 */
export function appsEyebrow(view: AppRowsView): string {
  const built = view.rows.filter((row) => row.kind === 'app').length;
  switch (view.sites.state) {
    case 'ok': {
      const total = built + view.sites.total;
      return `${total} ${total === 1 ? 'app' : 'apps'} · ${built} app · ${view.sites.total} site`;
    }
    case 'unreadable':
      return `${built} ${built === 1 ? 'app' : 'apps'} · sites unreadable`;
    case 'off':
      return `${built} ${built === 1 ? 'app' : 'apps'}`;
  }
}

/**
 * A poll re-reads page 1. When the reader has loaded further pages, the older
 * site rows stay below it and the reader's cursor is kept.
 */
export function mergeAppRows(
  fresh: AppRowsView,
  current: AppRowsView,
): AppRowsView {
  if (fresh.sites.state !== 'ok' || fresh.next === null) return fresh;
  const sitesIn = (view: AppRowsView) =>
    view.rows.filter((row) => row.kind === 'site').length;
  if (sitesIn(current) <= sitesIn(fresh)) return fresh;
  const seen = new Set(fresh.rows.map((row) => row.key));
  const older = current.rows.filter(
    (row) => row.kind === 'site' && !seen.has(row.key),
  );
  return { ...fresh, rows: [...fresh.rows, ...older], next: current.next };
}

/** Appends a later page of sites, skipping any row already on screen. */
export function appendAppRows(
  current: AppRowsView,
  page: AppRowsView,
): AppRowsView {
  const seen = new Set(current.rows.map((row) => row.key));
  return {
    rows: [...current.rows, ...page.rows.filter((row) => !seen.has(row.key))],
    sites: page.sites.state === 'ok' ? page.sites : current.sites,
    next: page.next,
  };
}

/**
 * Shared by the header and every row. It collapses below `lg` to the name and
 * status, over a line of deployment and domain.
 */
const COLUMNS =
  'grid-cols-[minmax(0,1fr)_auto] lg:grid-cols-[minmax(0,1.1fr)_136px_minmax(0,1.3fr)_minmax(0,1.1fr)_96px]';

/**
 * The trash sits beside the row's button, since buttons cannot nest. A site
 * row keeps the trash's width empty so its columns line up.
 */
function RowEnd({ children }: { readonly children?: ReactNode }) {
  return (
    <span className="flex items-center gap-1 pr-3">
      {children ?? <span aria-hidden="true" className="size-9" />}
      <ChevronRight
        aria-hidden="true"
        className="size-4 shrink-0 text-muted-foreground"
      />
    </span>
  );
}

function RowCells({
  kind,
  name,
  subtitle,
  dot,
  status,
  deployment,
  domain,
  at,
  when,
}: {
  readonly kind: AppRowView['kind'];
  readonly name: string;
  readonly subtitle: string | null;
  readonly dot: ReactNode;
  readonly status: string;
  readonly deployment: string;
  readonly domain: string;
  readonly at?: string;
  readonly when?: string;
}) {
  return (
    <>
      <span className="flex min-w-0 flex-col gap-1">
        <span className="flex min-w-0 items-center gap-2">
          <Badge className="normal-case">{kind}</Badge>
          <span className="truncate font-mono text-ui font-semibold tracking-tight">
            {name}
          </span>
        </span>
        {subtitle === null ? null : (
          <span className="truncate font-mono text-caption text-muted-foreground">
            {subtitle}
          </span>
        )}
      </span>

      <span className="flex items-center gap-2 justify-self-end text-body lg:justify-self-start">
        {dot}
        {status}
      </span>

      <span className="col-span-2 truncate font-mono text-caption text-muted-foreground lg:hidden">
        {deployment} · {domain}
      </span>

      <span
        className="hidden truncate font-mono text-body text-muted-foreground lg:block"
        title={deployment}
      >
        {deployment}
      </span>
      <span
        className="hidden truncate font-mono text-body text-subtle lg:block"
        title={domain}
      >
        {domain}
      </span>
      <span className="hidden truncate text-right text-body text-muted-foreground lg:block">
        {at ? <Timestamp at={at} when={when} /> : '—'}
      </span>
    </>
  );
}

const ROW =
  'flex items-stretch border-b border-border-soft last:border-b-0 hover:bg-secondary/60';
const ROW_BUTTON =
  'grid min-w-0 flex-1 items-center gap-x-4 gap-y-1 px-4 py-3 text-left';

export function AppRow({
  app,
  onNavigate,
  deletion,
}: {
  app: AppListItem;
  onNavigate: (path: string) => void;
  deletion: AppDeletionControls;
}) {
  const status = appStatusWord(app);
  return (
    <li className={ROW}>
      <button
        type="button"
        aria-label={`${app.name}, app, ${status}`}
        onClick={() => onNavigate(`/apps/${app.id}`)}
        className={cn(ROW_BUTTON, COLUMNS)}
      >
        <RowCells
          kind="app"
          name={app.name}
          subtitle={app.source}
          dot={<AppDot app={app} />}
          status={status}
          deployment={appDeployment(app)}
          domain={domainOf(app.url)}
          at={app.at}
          when={app.when}
        />
      </button>
      <RowEnd>
        <DeleteAppButton appId={app.id} name={app.name} deletion={deletion} />
      </RowEnd>
    </li>
  );
}

/** No delete: sites are read-only here. */
export function SiteRow({
  site,
  onNavigate,
}: {
  site: SiteListItem;
  onNavigate: (path: string) => void;
}) {
  const status = siteStatusWord(site);
  return (
    <li className={ROW}>
      <button
        type="button"
        aria-label={`${site.name}, site, ${status}`}
        onClick={() => onNavigate(`/sites/${site.name}`)}
        className={cn(ROW_BUTTON, COLUMNS)}
      >
        <RowCells
          kind="site"
          name={site.name}
          subtitle={
            site.owner === undefined ? null : (site.owner ?? 'anonymous')
          }
          dot={<SiteDot release={site.release} />}
          status={status}
          deployment={siteDeployment(site)}
          domain={domainOf(site.url)}
          at={site.at}
          when={site.when}
        />
      </button>
      <RowEnd />
    </li>
  );
}

function SitesFooter({
  view,
  loadingMore,
  loadError,
  onLoadMore,
}: {
  readonly view: AppRowsView;
  readonly loadingMore: boolean;
  readonly loadError: string | null;
  readonly onLoadMore?: () => void;
}) {
  if (view.sites.state !== 'ok') return null;
  return (
    <>
      {loadError ? (
        <p className="text-body text-destructive">{loadError}</p>
      ) : null}
      {view.next !== null ? (
        <div className="flex justify-center">
          <Button variant="outline" disabled={loadingMore} onClick={onLoadMore}>
            {loadingMore ? 'Loading more sites…' : 'Load more sites'}
          </Button>
        </div>
      ) : (
        <p className="text-center text-caption text-muted-foreground">
          Every site loaded.
        </p>
      )}
    </>
  );
}

/** Each read asks for this many, and the aside shows this many of both. */
export const ACTIVITY_ROWS = 6;

/**
 * The newest Builds and Deploys beside the list. `entries` is `null` while the
 * first read is out; a failed read is one line here, never the whole screen.
 */
export function ActivityAside({
  entries,
  failure = null,
  onNavigate,
}: {
  readonly entries: readonly ActivityEntry[] | null;
  readonly failure?: string | null;
  readonly onNavigate: (path: string) => void;
}) {
  let body: ReactNode;
  if (failure !== null) {
    body = (
      <p className="px-4 py-3 text-caption text-muted-foreground">
        Activity could not be read: {failure}
      </p>
    );
  } else if (entries === null) {
    body = <SkeletonRows rows={3} />;
  } else if (entries.length === 0) {
    body = (
      <p className="px-4 py-3 text-caption text-muted-foreground">
        No Build or Deploy yet.
      </p>
    );
  } else {
    body = (
      <ol>
        {entries.slice(0, ACTIVITY_ROWS).map((entry) => (
          <li
            key={entry.id}
            className="border-b border-border-soft last:border-b-0"
          >
            <button
              type="button"
              onClick={() => onNavigate(entry.path)}
              className="flex w-full min-w-0 flex-col gap-1 px-4 py-2.5 text-left hover:bg-secondary/60"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate font-mono text-body font-semibold tracking-tight">
                  {entry.title}
                </span>
                <Badge tone={entry.tone} className="ml-auto shrink-0">
                  {entry.status}
                </Badge>
              </span>
              <span className="flex min-w-0 items-baseline gap-2 text-caption text-muted-foreground">
                <span className="truncate" title={entry.detail}>
                  {entry.detail}
                </span>
                <Timestamp
                  at={entry.at}
                  when={entry.when}
                  className="ml-auto shrink-0 font-mono"
                />
              </span>
            </button>
          </li>
        ))}
      </ol>
    );
  }
  return (
    <aside
      aria-label="Activity"
      className="flex min-w-0 flex-col self-start overflow-hidden rounded-sm border border-border bg-card"
    >
      <div className="flex items-center gap-3 border-b border-border-soft bg-secondary/60 px-4 py-2">
        <h2 className="font-mono text-micro font-bold uppercase tracking-eyebrow text-muted-foreground">
          Activity
        </h2>
        <button
          type="button"
          onClick={() => onNavigate('/deploys')}
          className="ml-auto text-caption text-muted-foreground hover:text-foreground"
        >
          View all
        </button>
      </div>
      {body}
    </aside>
  );
}

/** Its own read, so a slow or failed ledger never holds up the list. */
function AppsActivity({
  onNavigate,
}: {
  readonly onNavigate: (path: string) => void;
}) {
  const read = useRead(
    [
      ['listBuilds', { limit: ACTIVITY_ROWS }],
      ['listAllDeploys', { limit: ACTIVITY_ROWS }],
    ],
    15_000,
  );
  if (read.type === 'error') {
    return (
      <ActivityAside
        entries={null}
        failure={read.failure.message}
        onNavigate={onNavigate}
      />
    );
  }
  return (
    <ActivityAside
      entries={
        read.type === 'success'
          ? activityEntries(read.value[0].builds, read.value[1].deploys)
          : null
      }
      onNavigate={onNavigate}
    />
  );
}

/**
 * No hooks: the app list identity test calls this as a plain function, so the
 * filter and paging state live in {@link AppsScreen}, and the aside's read in
 * the element it passes as `aside`.
 */
export function AppList({
  view,
  onNavigate,
  deletion,
  filter = '',
  onFilter,
  filterRef,
  loadingMore = false,
  loadError = null,
  onLoadMore,
  aside,
}: {
  view: AppRowsView;
  onNavigate: (path: string) => void;
  deletion: AppDeletionControls;
  filter?: string;
  onFilter?: (value: string) => void;
  filterRef?: RefObject<HTMLInputElement | null>;
  loadingMore?: boolean;
  loadError?: string | null;
  onLoadMore?: () => void;
  aside?: ReactNode;
}) {
  const { rows } = view;
  const needle = filter.trim().toLowerCase();
  const shown =
    needle === '' ? rows : rows.filter((row) => haystack(row).includes(needle));

  return (
    <Page width="wide">
      <ExplorerPageHeader
        eyebrow={appsEyebrow(view)}
        title="Apps"
        description="Every App: built here from source, or published to kthx as a site. A built App shows the state of its worst Component."
        actions={
          <Button onClick={() => onNavigate('/apps/new')}>
            <Plus aria-hidden="true" className="size-4" /> New App
          </Button>
        }
      />

      {/* Beside the list only from 2xl: narrower, the list's five columns
          truncate its names. Below that the aside follows the list. */}
      <div
        className={cn(
          'grid items-start gap-6',
          aside !== undefined && '2xl:grid-cols-[minmax(0,1fr)_20rem]',
        )}
      >
        <div className="flex min-w-0 flex-col gap-6">
          {view.sites.state === 'unreadable' ? (
            <p
              role="status"
              className="rounded-sm border border-border bg-card px-4 py-3 text-body text-muted-foreground"
            >
              kthx sites are missing from this list: {view.sites.reason}
            </p>
          ) : null}

          {rows.length === 0 ? (
            <div className="rounded-sm border border-border bg-card px-6 py-12 text-center">
              <p className="text-body text-muted-foreground">
                No Apps yet. Create one to establish its first deployment
                contract.
              </p>
              <Button className="mt-4" onClick={() => onNavigate('/apps/new')}>
                <Plus aria-hidden="true" className="size-4" /> Create App
              </Button>
            </div>
          ) : (
            <>
              <label className="flex max-w-sm items-center gap-2 rounded-sm border border-border bg-card px-3">
                <Search
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground"
                />
                <input
                  ref={filterRef}
                  value={filter}
                  onChange={(event) => onFilter?.(event.target.value)}
                  placeholder={`Filter the ${rows.length} loaded Apps`}
                  aria-label="Filter the loaded Apps"
                  className="w-full bg-transparent py-2 text-body outline-none placeholder:text-muted-foreground"
                />
                {filter === '' ? <Kbd>/</Kbd> : null}
              </label>

              <div className="overflow-hidden rounded-sm border border-border bg-card">
                <div
                  aria-hidden="true"
                  className="hidden border-b border-border-soft bg-secondary/60 lg:flex"
                >
                  <div
                    className={cn(
                      'grid flex-1 gap-x-4 px-4 py-2',
                      'font-mono text-micro font-bold uppercase tracking-eyebrow text-muted-foreground',
                      COLUMNS,
                    )}
                  >
                    <span>App</span>
                    <span>Status</span>
                    <span>Deployment</span>
                    <span>Domain</span>
                    <span className="text-right">Deployed</span>
                  </div>
                  <span className="invisible flex">
                    <RowEnd />
                  </span>
                </div>

                {shown.length === 0 ? (
                  <p className="px-4 py-10 text-center text-body text-muted-foreground">
                    No loaded App matches “{filter}”.
                  </p>
                ) : (
                  <ul>
                    {shown.map((row) =>
                      row.kind === 'app' ? (
                        <AppRow
                          key={row.key}
                          app={row.app}
                          onNavigate={onNavigate}
                          deletion={deletion}
                        />
                      ) : (
                        <SiteRow
                          key={row.key}
                          site={row.site}
                          onNavigate={onNavigate}
                        />
                      ),
                    )}
                  </ul>
                )}
              </div>
            </>
          )}

          <SitesFooter
            view={view}
            loadingMore={loadingMore}
            loadError={loadError}
            onLoadMore={onLoadMore}
          />
        </div>
        {aside}
      </div>
    </Page>
  );
}

export function AppsScreen({
  onNavigate,
}: {
  onNavigate: (path: string) => void;
}) {
  const [filter, setFilter] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const box = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const active = document.activeElement;
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      box.current?.focus();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const read = useRead(
    [['listAppRows', {}]],
    (listed) =>
      listed?.[0].rows.some(
        (row) => row.kind === 'app' && isInFlight(row.app.phase),
      )
        ? 3_000
        : 20_000,
    [],
    ([fresh], [current]) => [mergeAppRows(fresh, current)],
  );

  const deletion = useAppDeletion(({ id, name }) => {
    read.update(([listed]) => [
      { ...listed, rows: listed.rows.filter((row) => row.key !== id) },
    ]);
    notify({ tone: 'success', title: `Deleted ${name}` });
  });

  const loadMore = async () => {
    if (read.type !== 'success') return;
    const [listed] = read.value;
    if (listed.next === null) return;
    setLoadingMore(true);
    setLoadError(null);
    try {
      const result = await command('listAppRows', { after: listed.next });
      if (!result.ok) {
        setLoadError(result.failure.message);
        return;
      }
      const page = result.value;
      if (page.sites.state === 'unreadable') {
        setLoadError(`kthx sites could not be read: ${page.sites.reason}`);
        return;
      }
      read.update(([current]) => [appendAppRows(current, page)]);
    } catch (cause) {
      setLoadError(
        cause instanceof Error ? cause.message : 'Loading more sites failed',
      );
    } finally {
      setLoadingMore(false);
    }
  };

  if (read.type === 'loading') return <LedgerSkeleton width="wide" />;
  if (read.type === 'error') {
    return (
      <ScreenFailure
        title="Failed to load Apps"
        message={read.failure.message}
        onRetry={read.reload}
      />
    );
  }
  const [listed] = read.value;
  return (
    <>
      <AppList
        view={listed}
        onNavigate={onNavigate}
        deletion={deletion}
        filter={filter}
        onFilter={setFilter}
        filterRef={box}
        loadingMore={loadingMore}
        loadError={loadError}
        onLoadMore={() => void loadMore()}
        aside={<AppsActivity onNavigate={onNavigate} />}
      />
      <DeleteAppDialog deletion={deletion} />
    </>
  );
}
