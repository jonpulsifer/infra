/**
 * The kthx CLI: how to install it from this installation's kthx, and every
 * verb it dispatches. It adds nothing the CLI lacks.
 */
import type { DeveloperSurfaces } from '../../../commands/developer/surfaces.ts';
import { Page, PageHeader } from '../../ui/page.tsx';
import { NoKthx, Prose, Section, Snippet, SurfacesScreen } from './shared.tsx';

interface Verb {
  /** The dispatcher's arm: `case '<verb>':` in the CLI's entry point. */
  readonly verb: string;
  readonly usage: string;
  readonly does: string;
}

/** In the CLI's own order. A test holds this to its dispatcher. */
export const CLI_VERBS: readonly Verb[] = [
  {
    verb: 'init',
    usage: 'kthx init [dir]',
    does: 'Claim a name, and write kthx.json, SKILL.md and a starter page.',
  },
  {
    verb: 'deploy',
    usage: 'kthx deploy [dir]',
    does: "Sync the directory to the site's folder in the sites bucket. --force writes over a site someone else owns.",
  },
  {
    verb: 'dev',
    usage: 'kthx dev [dir]',
    does: "Serve the directory on :4321 against the site's live backends.",
  },
  {
    verb: 'ls',
    usage: 'kthx ls [dir]',
    does: "The site's owner and last deploy. With no kthx.json, every site of yours.",
  },
  {
    verb: 'ls',
    usage: 'kthx ls --all',
    does: 'Every site on the origin.',
  },
  {
    verb: 'rm',
    usage: 'kthx rm [dir]',
    does: 'Delete the site and free its name.',
  },
  {
    verb: 'open',
    usage: 'kthx open [dir]',
    does: 'Open the site in a browser.',
  },
  {
    verb: 'upgrade',
    usage: 'kthx upgrade',
    does: 'Replace this copy with the build the origin serves.',
  },
  {
    verb: 'nuke',
    usage: 'kthx nuke [--yes]',
    does: 'Operator only: delete every site. It opens only for an admin login on the tailnet identity host.',
  },
  {
    verb: 'mcp',
    usage: 'kthx mcp [dir]',
    does: "Print the site's MCP address, which takes the owner's Google ID token. This build has no stdio bridge.",
  },
];

function quickstart(origin: string): string {
  return [
    `bun add -g ${origin}/cli/kthx.tgz`,
    'gcloud auth application-default login',
    `export KTHX_ORIGIN=${origin}`,
    'kthx init my-site',
    'kthx deploy my-site',
  ].join('\n');
}

/** No hooks, so a static render shows every state. */
export function CliPage({
  surfaces,
}: {
  readonly surfaces: DeveloperSurfaces;
}) {
  const { kthx } = surfaces;
  return (
    <Page width="reading">
      <PageHeader
        eyebrow="developer"
        title="CLI"
        description="kthx turns a directory into a site. The CLI claims a name and syncs the directory to the site's folder in the sites bucket."
      />

      <Section title="Install">
        {kthx === null ? (
          <NoKthx what="There is no origin to install the CLI from, so this page names none." />
        ) : (
          <>
            <Prose>
              Install it with Bun from this installation's kthx, point it there,
              and claim a site. A site answers at{' '}
              <code>https://&lt;name&gt;.{kthx.zone}</code>.
            </Prose>
            <Snippet label="install commands" text={quickstart(kthx.origin)} />
          </>
        )}
      </Section>

      <Section title="Commands">
        <dl className="divide-y divide-border-soft overflow-hidden rounded-sm border border-border">
          {CLI_VERBS.map(({ usage, does }) => (
            <div
              key={usage}
              className="grid gap-1 px-4 py-3 sm:grid-cols-[13rem_minmax(0,1fr)] sm:gap-4"
            >
              <dt className="font-mono text-body text-foreground">{usage}</dt>
              <dd className="text-body text-muted-foreground">{does}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section title="Credentials">
        <Prose>
          The CLI writes the sites bucket with your Google Application Default
          Credentials: <code>gcloud auth application-default login</code>, or a
          workload's <code>external_account</code> file. Their email owns what
          you deploy, and owner calls to kthx carry a Google ID token. Ownership
          is a courtesy: deploying over someone else's site asks first.
        </Prose>
      </Section>

      <Section title="Update check">
        <Prose>
          In a terminal, each command asks the origin whether it serves a newer
          build and says so. <code>KTHX_NO_UPDATE_CHECK=1</code> turns the check
          off. <code>kthx upgrade</code> installs the origin's build.
        </Prose>
      </Section>
    </Page>
  );
}

export function CliScreen() {
  return (
    <SurfacesScreen title="CLI">
      {(surfaces) => <CliPage surfaces={surfaces} />}
    </SurfacesScreen>
  );
}
