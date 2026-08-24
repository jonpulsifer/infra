/**
 * The App list (§18).
 *
 * **The scan of what exists** — name, phase, placement, URL — is the entry
 * surface. A row navigates to the workspace; the list itself never renders
 * pipeline detail.
 *
 * **A row is a row, not a row plus an inspector.** This screen used to be an
 * `ObjectExplorer`: pressing an App selected it and filled a panel beside the
 * list, and reaching the App took a second press on an `Open App` button in
 * that panel. The panel restated the row — kind, target, vessel, source,
 * artifact, URL — which is the workspace's job, one press further on, done
 * better. So the fields the panel was holding move onto the row where they can
 * be scanned down a column, and the press that used to select now navigates.
 * §18's "the running App is the product" is the same argument: the catalog is
 * a way to reach an App, not a place to read one.
 *
 * The one action is **New App**, which is the same front-page tile the creation
 * flow opens with. An empty list is its own onboarding: the first thing a fresh
 * install sees is that action, not a dashboard with empty charts.
 *
 * The exception is the trash affordance on each row. It is here rather than
 * only in the workspace because the App this list most often has too many of is
 * the one nothing was ever deployed from, and making the operator open a
 * workspace to throw one away is what leaves a fresh install's failed first
 * attempts on the screen forever. It is a **sibling** of the row's button
 * rather than inside it — a button inside a button is invalid, and the stretched
 * overlay that avoids that is a way to make one control silently swallow the
 * other. What it opens is a review, not a delete; `components/delete-app.tsx`
 * owns that whole flow.
 *
 * **A row stands for an App, not for a name.** `apps` has no unique constraint
 * on `name`, so the key, the link, and the delete all go by `AppListItem.id`.
 * By name, two Apps called the same thing share one React key, one workspace,
 * and one refused delete — which leaves the second one persisted and with no
 * route to it at all.
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

/**
 * What the row says beside the name on a narrow screen, where the columns to
 * its right have collapsed.
 *
 * The scan this list exists to be is "which of these needs me", and the fact
 * that answers it on a multi-Component App is how much of it is down, not that
 * something is. The count is stated only where there is more than one
 * Component, because "1 component" on every row of a fleet of single-service
 * Apps is a column of noise that pushes the fact off the end of the line.
 */
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
  return `${app.name} ${app.kind} ${app.target} ${app.vessel} ${app.source} ${app.url} ${app.artifact} ${app.commit ?? ''}`.toLowerCase();
}

/**
 * The column template, in one place because the header and the rows have to
 * agree and there is no way to see that they do not until they are side by
 * side on a screen.
 *
 * It collapses at `lg` rather than at `md`: seven columns in a 240px-narrower
 * page is where the commit starts wrapping under the target, and a wrapped
 * monospace cell reads as a second row.
 */
const COLUMNS =
  'grid-cols-[minmax(0,1fr)_auto] lg:grid-cols-[minmax(0,1.2fr)_112px_minmax(0,1.3fr)_92px_minmax(0,0.9fr)_88px]';

/** One App. The button is the row; the trash sits outside it. */
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
          <PhasePill phase={app.phase} />
        </span>

        {/* Below `lg` the four columns after the phase become one muted line
            under the name, because a column that has to wrap is not a column. */}
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
 * **No hooks here, deliberately.** `app-list-identity.test.tsx` calls this
 * function directly and reads the tree it returns, because what it proves is
 * *which id* a handler is closed over — and that is not something rendered
 * markup can show. A `useState` in this component makes that whole file throw
 * on a null dispatcher, so the filter's state lives one level up in
 * {@link AppsScreen} and arrives here as two props.
 *
 * Which is where it belongs anyway: the screen owns what it is showing, the
 * view renders it.
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

/**
 * The Apps screen — the list, the two cadences it re-reads on, and the delete
 * it answers locally.
 *
 * **Two cadences, the same argument the workspace makes.** This screen read
 * once at mount and never again, so a row whose App was mid-release sat on the
 * phase it happened to have at that instant — under a dot that pulses forever,
 * which reads as "still moving" about a release that finished minutes ago.
 *
 * **The row goes when the App does**, without a re-read: that would be a second
 * round trip to learn something this screen was just told. By id, because
 * `apps` has no unique constraint on `name` — filtering on the name drops every
 * row sharing it, so deleting one of two same-named Apps would hide the other
 * until a reload, and reaching the other one is the whole point of giving this
 * list an identity.
 */
export function AppsScreen({
  onNavigate,
}: {
  onNavigate: (path: string) => void;
}) {
  const [filter, setFilter] = useState('');
  const box = useRef<HTMLInputElement>(null);

  /**
   * `/` reaches the filter from anywhere on the screen, the way it does in
   * every list an operator already lives in. Guarded on the active element so
   * it never takes the key from a field someone is typing a slash into — there
   * is one on this screen the moment a delete review opens, and one in the
   * command palette over the top of it.
   */
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
    // The dialog that confirmed this closes with the press, so without this the
    // only evidence the act happened is a row that is no longer there — which
    // is indistinguishable from having deleted the wrong one.
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
