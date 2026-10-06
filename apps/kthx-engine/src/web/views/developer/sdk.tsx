/**
 * The kthx browser SDK, as it is: one classic script a kthx site loads from its
 * own origin, with no package and no types.
 */
import { ExternalLink } from 'lucide-react';
import type { DeveloperSurfaces } from '../../../commands/developer/surfaces.ts';
import { Button } from '../../ui/button.tsx';
import { Page, PageHeader } from '../../ui/page.tsx';
import { NoKthx, Prose, Section, Snippet, SurfacesScreen } from './shared.tsx';

/** Every member of `window.kthx`, in the order the script assigns them. */
export const SDK_MEMBERS: readonly {
  readonly name: string;
  readonly is: string;
}[] = [
  {
    name: 'db',
    is: 'Documents in named collections: create, get, update, query, count and subscribe.',
  },
  {
    name: 'live',
    is: "Rooms that relay messages between the site's visitors.",
  },
  {
    name: 'ai',
    is: 'An OpenAI-compatible model endpoint: chat, and a baseURL for the OpenAI SDK.',
  },
  { name: 'files', is: 'Upload, list, link and delete files.' },
  {
    name: 'me',
    is: '{id}: a signed anonymous id, stable per browser per site.',
  },
  { name: 'site', is: '{name, url} of the site the page is on.' },
  {
    name: 'ready',
    is: 'Resolves after the first /api/me. Only me and site wait on it.',
  },
];

const TAG = '<script src="/api/sdk.js"></script>';

const EXAMPLE = [
  'await kthx.ready',
  "const notes = kthx.db.collection('notes')",
  "await notes.create({ title: 'hi' })",
  'const stop = notes.subscribe({ onCreate: (doc) => console.log(doc) })',
].join('\n');

/** No hooks, so a static render shows every state. */
export function SdkPage({
  surfaces,
}: {
  readonly surfaces: DeveloperSurfaces;
}) {
  const { kthx } = surfaces;
  const reference = kthx === null ? null : `https://${kthx.zone}/skill.md`;
  return (
    <Page width="reading">
      <PageHeader
        eyebrow="developer"
        title="SDK"
        description="One script a kthx site loads from its own origin. It works on a kthx site only."
        actions={
          reference === null ? null : (
            <Button variant="outline" asChild>
              <a href={reference} target="_blank" rel="noopener noreferrer">
                Full reference{' '}
                <ExternalLink aria-hidden="true" className="size-3.5" />
              </a>
            </Button>
          )
        }
      />

      <Section title="Load it">
        <Prose>
          A page on a kthx site adds one tag. The path is the site's own, so it
          needs no key, no project id and no configuration. Anywhere else,
          including this console, there is nothing behind it to talk to.
        </Prose>
        <Snippet label="script tag" text={TAG} />
        <Prose>
          It is a classic script that defines <code>window.kthx</code>. There is
          no npm package to install and no type definitions to import.
        </Prose>
      </Section>

      <Section title="window.kthx">
        <dl className="divide-y divide-border-soft overflow-hidden rounded-sm border border-border">
          {SDK_MEMBERS.map(({ name, is }) => (
            <div
              key={name}
              className="grid gap-1 px-4 py-3 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-4"
            >
              <dt className="font-mono text-body text-foreground">
                kthx.{name}
              </dt>
              <dd className="text-body text-muted-foreground">{is}</dd>
            </div>
          ))}
        </dl>
        <Snippet label="example" text={EXAMPLE} />
      </Section>

      <Section title="Reference">
        {reference === null ? (
          <NoKthx what="There is no zone to read the reference from, so this page links to none." />
        ) : (
          <Prose>
            Every call, limit and error code is in{' '}
            <a
              href={reference}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-accent-foreground underline underline-offset-2"
            >
              {reference}
            </a>
            , which <code>kthx init</code> also writes into each site as
            SKILL.md.
          </Prose>
        )}
      </Section>
    </Page>
  );
}

export function SdkScreen() {
  return (
    <SurfacesScreen title="SDK">
      {(surfaces) => <SdkPage surfaces={surfaces} />}
    </SurfacesScreen>
  );
}
