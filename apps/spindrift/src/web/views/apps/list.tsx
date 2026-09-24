/**
 * The App list. A row opens the App's workspace, and its key, link and delete
 * go by App id, because App names are not unique.
 */
import { ChevronRight, Globe, Plus, Search, Server, Zap } from 'lucide-react';
import type { RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { AppListItem } from '../../../commands/views.ts';
import { isInFlight } from '../../../commands/views.ts';
import {
  type AppDeletionControls,
  DeleteAppButton,
  DeleteAppDialog,
  useAppDeletion,
} from '../../components/delete-app.tsx';
import { ExplorerPageHeader } from '../../components/object-explorer.tsx';
import { PhasePill } from '../../components/status.tsx';
import { useRead } from '../../poll.ts';
import { Button } from '../../ui/button.tsx';
import { Kbd } from '../../ui/kbd.tsx';
import { Page } from '../../ui/page.tsx';
import { Timestamp } from '../../ui/timestamp.tsx';
import { notify } from '../../ui/toast.tsx';
import { cn } from '../../ui/utils.ts';
import { LedgerSkeleton, ScreenFailure } from '../screen.tsx';

function kindIcon(kind: string) {
  switch (kind) {
    case 'website':
      return (
        <Globe aria-hidden="true" className="size-4 text-muted-foreground" />
      );
    case 'job':
      return (
        <Zap aria-hidden="true" className="size-4 text-muted-foreground" />
      );
    default:
      return (
        <Server aria-hidden="true" className="size-4 text-muted-foreground" />
      );
  }
}

/** A stored App address may be either a hostname or an absolute HTTP URL. */
export function appHref(url: string): string | null {
  const value = url.trim();
  if (value === '') return null;
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

/** The row's detail line below `lg`, counting Components only when several. */
function rowDetail(app: AppListItem): string {
  const parts: string[] = [app.kind, app.target];
  const count = app.componentCount ?? 0;
  if (count > 1) {
    parts.push(
      app.failing
        ? `${app.failing} of ${count} failing`
        : `${count} components`,
    );
  }
  return parts.join(' · ');
}

/** Everything a row matches on, including the facts it does not print. */
function haystack(app: AppListItem): string {
  return `${app.name} ${app.kind} ${app.target} ${app.vessel} ${app.source} ${app.url} ${app.artifact} ${app.commit ?? ''} ${app.commitMessage ?? ''}`.toLowerCase();
}

/**
 * Shared by the header and every row. It collapses at `lg`, since at `md` the
 * commit column wraps.
 */
const COLUMNS =
  'grid-cols-[minmax(0,1fr)_auto] lg:grid-cols-[minmax(0,1.2fr)_112px_minmax(0,1.3fr)_92px_minmax(0,0.9fr)_88px]';

/** The trash sits beside the row's button, since buttons cannot nest. */
export function AppRow({
  app,
  onNavigate,
  deletion,
}: {
  app: AppListItem;
  onNavigate: (path: string) => void;
  deletion: AppDeletionControls;
}) {
  return (
    <li className="flex items-stretch border-b border-border-soft last:border-b-0 hover:bg-secondary/60">
      <button
        type="button"
        onClick={() => onNavigate(`/apps/${app.id}`)}
        className={cn(
          'grid min-w-0 flex-1 items-center gap-x-4 gap-y-1 px-4 py-3 text-left',
          COLUMNS,
        )}
      >
        <span className="flex min-w-0 items-center gap-2.5">
          {kindIcon(app.kind)}
          <span className="truncate text-ui font-semibold tracking-tight">
            {app.name}
          </span>
        </span>

        <span className="justify-self-end lg:justify-self-start">
          <PhasePill phase={app.phase} faulty={app.faulty} />
        </span>

        <span className="col-span-2 truncate font-mono text-caption text-muted-foreground lg:hidden">
          {rowDetail(app)}
          {app.url ? ` · ${app.url}` : ''}
        </span>

        <span className="hidden truncate font-mono text-body text-subtle lg:block">
          {app.url || (
            <span className="text-muted-foreground">not allocated</span>
          )}
        </span>
        <span
          className="hidden truncate font-mono text-body text-muted-foreground lg:block"
          title={app.commitMessage ?? undefined}
        >
          {app.commit ? app.commit.slice(0, 7) : '—'}
          {app.commitMessage ? (
            <span className="ml-2 font-sans">{app.commitMessage}</span>
          ) : null}
        </span>
        <span className="hidden truncate font-mono text-body text-muted-foreground lg:block">
          {app.target}
        </span>
        <span className="hidden truncate text-body text-muted-foreground lg:block">
          {app.at ? <Timestamp at={app.at} when={app.when} /> : '—'}
        </span>
      </button>

      <span className="flex items-center gap-1 pr-3">
        <DeleteAppButton appId={app.id} name={app.name} deletion={deletion} />
        <ChevronRight
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground"
        />
      </span>
    </li>
  );
}

/**
 * No hooks: the app list identity test calls this as a plain function, so the
 * filter state lives in {@link AppsScreen}.
 */
export function AppList({
  apps,
  onNavigate,
  deletion,
  filter = '',
  onFilter,
  filterRef,
}: {
  apps: readonly AppListItem[];
  onNavigate: (path: string) => void;
  deletion: AppDeletionControls;
  filter?: string;
  onFilter?: (value: string) => void;
  filterRef?: RefObject<HTMLInputElement | null>;
}) {
  const needle = filter.trim().toLowerCase();
  const shown =
    needle === '' ? apps : apps.filter((app) => haystack(app).includes(needle));
  const moving = apps.filter((app) => isInFlight(app.phase)).length;

  return (
    <Page width="wide">
      <ExplorerPageHeader
        eyebrow={
          moving > 0
            ? `${apps.length} Apps · ${moving} moving`
            : `${apps.length} Apps`
        }
        title="Apps"
        description="Every App this installation runs, and the state of the worst Component in each."
        actions={
          <Button onClick={() => onNavigate('/apps/new')}>
            <Plus aria-hidden="true" className="size-4" /> New App
          </Button>
        }
      />

      {apps.length === 0 ? (
        <div className="rounded-sm border border-border bg-card px-6 py-12 text-center">
          <p className="text-body text-muted-foreground">
            No Apps yet. Create one to establish its first deployment contract.
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
              placeholder={`Filter ${apps.length} Apps`}
              aria-label="Filter Apps"
              className="w-full bg-transparent py-2 text-body outline-none placeholder:text-muted-foreground"
            />
            {filter === '' ? <Kbd>/</Kbd> : null}
          </label>

          <div className="overflow-hidden rounded-sm border border-border bg-card">
            <div
              aria-hidden="true"
              className={cn(
                'hidden gap-x-4 border-b border-border-soft bg-secondary/60 px-4 py-2',
                'font-mono text-micro font-bold uppercase tracking-eyebrow text-muted-foreground',
                'lg:grid',
                COLUMNS,
              )}
            >
              <span>App</span>
              <span>State</span>
              <span>Address</span>
              <span>Commit</span>
              <span>Target</span>
              <span>Released</span>
            </div>

            {shown.length === 0 ? (
              <p className="px-4 py-10 text-center text-body text-muted-foreground">
                No App matches “{filter}”.
              </p>
            ) : (
              <ul>
                {shown.map((app) => (
                  <AppRow
                    key={app.id}
                    app={app}
                    onNavigate={onNavigate}
                    deletion={deletion}
                  />
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </Page>
  );
}

export function AppsScreen({
  onNavigate,
}: {
  onNavigate: (path: string) => void;
}) {
  const [filter, setFilter] = useState('');
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

  const read = useRead([['listApps', {}]], (listed) =>
    listed?.[0].apps.some((app) => isInFlight(app.phase)) ? 3_000 : 20_000,
  );

  const deletion = useAppDeletion(({ id, name }) => {
    read.update(([listed]) => [
      { ...listed, apps: listed.apps.filter((app) => app.id !== id) },
    ]);
    notify({ tone: 'success', title: `Deleted ${name}` });
  });

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
        apps={listed.apps}
        onNavigate={onNavigate}
        deletion={deletion}
        filter={filter}
        onFilter={setFilter}
        filterRef={box}
      />
      <DeleteAppDialog deletion={deletion} />
    </>
  );
}
