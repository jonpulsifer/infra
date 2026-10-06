/**
 * The two MCP servers: this console's, where every command is a tool, and the
 * one each kthx site serves over its own documents.
 */
import { KeyRound } from 'lucide-react';
import type { DeveloperSurfaces } from '../../../commands/developer/surfaces.ts';
import { DefinitionGrid } from '../../components/object-explorer.tsx';
import { Button } from '../../ui/button.tsx';
import { CopyButton } from '../../ui/copy.tsx';
import { EmptyState } from '../../ui/empty-state.tsx';
import { Page, PageHeader } from '../../ui/page.tsx';
import { NoKthx, Prose, Section, Snippet, SurfacesScreen } from './shared.tsx';

/** A site's tools, in the order kthx lists them. A test holds this to kthx. */
export const SITE_MCP_TOOLS: readonly {
  readonly name: string;
  readonly does: string;
}[] = [
  {
    name: 'site_info',
    does: 'The site: its address, the serving release, every release, usage and quotas.',
  },
  {
    name: 'db_collections',
    does: 'Every collection holding a document, with its count.',
  },
  { name: 'db_query', does: 'Documents matching a where object.' },
  { name: 'db_get', does: 'One document by id.' },
  { name: 'db_create', does: 'Store a document.' },
  {
    name: 'db_update',
    does: 'Merge a patch into a document, or overwrite it.',
  },
  { name: 'db_delete', does: 'Delete one document.' },
];

export const IDENTITY_PATH = '/settings/identity';

function addCommand(name: string, url: string, token: string): string {
  return `claude mcp add --transport http ${name} ${url} --header "Authorization: Bearer $${token}"`;
}

function Address({ url }: { readonly url: string | null }) {
  if (url === null) return 'none';
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate">{url}</span>
      <CopyButton value={url} label="address" />
    </span>
  );
}

/** No hooks, so a static render shows every state. */
export function McpPage({
  surfaces,
  onNavigate,
}: {
  readonly surfaces: DeveloperSurfaces;
  readonly onNavigate: (path: string) => void;
}) {
  const { adminMcp, kthx } = surfaces;
  const admin = adminMcp.private ?? adminMcp.public;
  const siteUrl = kthx === null ? null : `https://<site>.${kthx.zone}/api/mcp`;
  return (
    <Page width="reading">
      <PageHeader
        eyebrow="developer"
        title="MCP"
        description="Two MCP servers answer for kthx: this console's, for running the installation, and one on each site, for its documents."
      />

      <Section title="This console">
        <Prose>
          Every command this console runs is a tool here, and every tool is an
          act done as the token's owner. It takes an agent token, never a
          session cookie.
        </Prose>
        {admin === null ? (
          <EmptyState title="This deployment names no host for it">
            Neither a private nor a public host is set, so there is no address
            to give.
          </EmptyState>
        ) : (
          <>
            {/* The grid carries a top margin for a page's first section. */}
            <div className="[&>dl]:mt-0">
              <DefinitionGrid
                entries={[
                  {
                    label: 'Private · lab and tailnet',
                    value: <Address url={adminMcp.private} />,
                    title: adminMcp.private ?? 'none',
                    mono: true,
                  },
                  {
                    label: 'Public',
                    value: <Address url={adminMcp.public} />,
                    title: adminMcp.public ?? 'none',
                    mono: true,
                  },
                ]}
              />
            </div>
            <Snippet
              label="the add command"
              text={addCommand('kthx', admin, 'TOKEN')}
            />
          </>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" onClick={() => onNavigate(IDENTITY_PATH)}>
            <KeyRound aria-hidden="true" />
            Mint a token in Settings › Identity
          </Button>
          <span className="text-caption text-muted-foreground">
            A token shows once. Revoke it there too.
          </span>
        </div>
      </Section>

      <Section title="A site">
        {kthx === null || siteUrl === null ? (
          <NoKthx what="There is no zone for a site to answer in, so this page names no site address." />
        ) : (
          <>
            <Prose>
              Each kthx site serves its own tools at <code>{siteUrl}</code>.
              They take the site's owner bearer from <code>sites.json</code>;{' '}
              <code>kthx mcp</code> in the site's directory prints the address
              and the file. Name the server <code>kthx-&lt;site&gt;</code> so
              two sites stay apart.
            </Prose>
            <Snippet
              label="the site add command"
              text={addCommand('kthx-<site>', siteUrl, 'SITE_TOKEN')}
            />
            <dl className="divide-y divide-border-soft overflow-hidden rounded-sm border border-border">
              {SITE_MCP_TOOLS.map(({ name, does }) => (
                <div
                  key={name}
                  className="grid gap-1 px-4 py-3 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4"
                >
                  <dt className="font-mono text-body text-foreground">
                    {name}
                  </dt>
                  <dd className="text-body text-muted-foreground">{does}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </Section>
    </Page>
  );
}

export function McpScreen({
  onNavigate,
}: {
  readonly onNavigate: (path: string) => void;
}) {
  return (
    <SurfacesScreen title="MCP">
      {(surfaces) => <McpPage surfaces={surfaces} onNavigate={onNavigate} />}
    </SurfacesScreen>
  );
}
