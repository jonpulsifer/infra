/**
 * One kthx site, read-only: what it serves, its releases and its usage against
 * kthx's quotas. Every write to a site stays in kthx.
 */
import { ExternalLink, RefreshCw } from 'lucide-react';
import { type SiteView, siteStatusWord } from '../../../commands/views.ts';
import { DefinitionGrid } from '../../components/object-explorer.tsx';
import { SiteDot } from '../../components/status.tsx';
import { useRead } from '../../poll.ts';
import { Badge } from '../../ui/badge.tsx';
import { Button } from '../../ui/button.tsx';
import { Eyebrow } from '../../ui/card.tsx';
import { type Column, DataTable } from '../../ui/data-table.tsx';
import { Page, PageHeader } from '../../ui/page.tsx';
import { Timestamp } from '../../ui/timestamp.tsx';
import { cn } from '../../ui/utils.ts';
import { appHref } from '../apps/list.tsx';
import { DetailSkeleton, ScreenFailure, ScreenNotFound } from '../screen.tsx';

type SiteRelease = SiteView['releases'][number];

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;

function bytes(count: number): string {
  let value = count;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0
    ? `${value} ${UNITS[unit]}`
    : `${value.toFixed(value < 10 ? 1 : 0)} ${UNITS[unit]}`;
}

const COUNT = new Intl.NumberFormat('en-US');

function releaseColumns(site: SiteView): readonly Column<SiteRelease>[] {
  return [
    {
      id: 'n',
      header: 'Release',
      cell: (release) => (
        <span className="flex items-center gap-2">
          <span className="font-mono">{release.n}</span>
          {release.n === site.release ? (
            <Badge tone="success" className="normal-case">
              serving
            </Badge>
          ) : null}
          {release.n === site.release && site.held ? (
            <Badge className="normal-case">held</Badge>
          ) : null}
        </span>
      ),
    },
    {
      id: 'digest',
      header: 'Digest',
      mono: true,
      cell: (release) => (
        <span title={release.digest}>
          {release.digest.replace(/^sha256:/, '').slice(0, 12)}
        </span>
      ),
    },
    {
      id: 'size',
      header: 'Size',
      align: 'end',
      cell: (release) => bytes(release.size),
    },
    {
      id: 'at',
      header: 'Uploaded',
      align: 'end',
      cell: (release) => <Timestamp at={release.at} />,
    },
  ];
}

/** No hooks, so a static render shows every state. */
export function SiteDetail({
  site,
  onReload,
  reloading = false,
}: {
  readonly site: SiteView;
  readonly onReload?: () => void;
  readonly reloading?: boolean;
}) {
  const href = appHref(site.url);
  const status = siteStatusWord(site);
  return (
    <Page width="reading">
      <PageHeader
        eyebrow="site"
        title={<span className="font-mono">{site.name}</span>}
        description={site.url}
        actions={
          href === null ? null : (
            <Button variant="outline" asChild>
              <a href={href} target="_blank" rel="noopener noreferrer">
                Open site{' '}
                <ExternalLink aria-hidden="true" className="size-3.5" />
              </a>
            </Button>
          )
        }
      />

      <div className="flex flex-wrap items-center gap-3 text-caption text-muted-foreground">
        <span>Read from kthx when this page opened. Sites change in kthx.</span>
        {onReload ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onReload}
            disabled={reloading}
          >
            <RefreshCw
              aria-hidden="true"
              className={cn('size-3.5', reloading && 'animate-spin')}
            />
            {reloading ? 'Reloading…' : 'Reload'}
          </Button>
        ) : null}
      </div>

      <DefinitionGrid
        entries={[
          {
            label: 'Status',
            value: (
              <span className="flex items-center gap-2">
                <SiteDot release={site.release} />
                {status}
              </span>
            ),
            title: status,
          },
          {
            label: 'Release',
            value:
              site.release === null
                ? '—'
                : site.held
                  ? `release ${site.release} · held`
                  : `release ${site.release}`,
            mono: true,
          },
          ...(site.owner === undefined
            ? []
            : [{ label: 'Owner', value: site.owner ?? 'anonymous' }]),
          { label: 'Address', value: site.url, mono: true },
          {
            label: 'Claimed',
            value: <Timestamp at={site.createdAt} />,
            title: site.createdAt,
          },
          {
            label: 'Deployed',
            value: site.at ? <Timestamp at={site.at} when={site.when} /> : '—',
            ...(site.at ? { title: site.at } : {}),
          },
          {
            label: 'Database',
            value: site.provisioned ? 'ready' : 'repairing',
          },
        ]}
      />

      <section className="flex flex-col gap-3">
        <Eyebrow>Releases</Eyebrow>
        {site.releases.length === 0 ? (
          <p className="rounded-sm border border-border bg-card px-4 py-6 text-center text-body text-muted-foreground">
            Nothing uploaded yet.
          </p>
        ) : (
          <DataTable
            columns={releaseColumns(site)}
            rows={site.releases}
            rowKey={(release) => String(release.n)}
            caption={`Releases of ${site.name}, newest first`}
          />
        )}
      </section>

      <section className="flex flex-col [&>dl]:mt-3">
        <Eyebrow>Usage</Eyebrow>
        <DefinitionGrid
          entries={[
            {
              label: 'Database',
              value: `${bytes(site.usage.dbBytes)} of ${bytes(site.quotas.dbBytes)}`,
            },
            {
              label: 'Files',
              value: `${bytes(site.usage.filesBytes)} of ${bytes(site.quotas.filesBytes)}`,
            },
            {
              label: 'AI requests today',
              value: `${COUNT.format(site.usage.aiRequestsToday)} of ${COUNT.format(site.quotas.aiRequestsDay)}`,
            },
            {
              label: 'AI tokens today',
              value: `${COUNT.format(site.usage.aiTokensToday)} of ${COUNT.format(site.quotas.aiTokensDay)}`,
            },
          ]}
        />
      </section>
    </Page>
  );
}

/** Reads once: nothing on this screen changes a site. */
export function SiteScreen({
  name,
  onNavigate,
}: {
  name: string;
  onNavigate: (path: string) => void;
}) {
  const read = useRead([['getSite', { name }]] as const, null, [name]);

  if (read.type === 'loading') return <DetailSkeleton />;
  if (read.type === 'error') {
    // A name kthx could never serve fails validation, and to a reader it is
    // also not found.
    return read.failure.code === 'NOT_FOUND' ||
      read.failure.code === 'INVALID_INPUT' ? (
      <ScreenNotFound
        title="Site not found"
        message={read.failure.message}
        onNavigate={onNavigate}
      />
    ) : (
      <ScreenFailure
        title="Failed to load the site"
        message={read.failure.message}
        width="reading"
        onRetry={read.reload}
      />
    );
  }
  const [result] = read.value;
  if (result.state === 'unreadable') {
    return (
      <ScreenFailure
        title="kthx could not be read"
        message={result.reason}
        width="reading"
        onRetry={read.reload}
      />
    );
  }
  return (
    <SiteDetail
      site={result.site}
      onReload={read.reload}
      reloading={read.pending}
    />
  );
}
