/** The Settings screen: a section rail, and the section the path names. */
import type { ReactNode } from 'react';
import { Eyebrow } from '../../ui/card.tsx';
import { Tabs } from '../../ui/tabs.tsx';
import { AgentTokens } from '../auth/agent-tokens.tsx';
import { InstallationSettings } from '../auth/installation.tsx';
import { IdentitySettings } from '../auth/settings.tsx';
import { RepositoriesScreen } from '../repos/list.tsx';
import { TargetsScreen } from '../targets/list.tsx';
import { ArtifactRegistries, Builders, SourceBuckets } from './connections.tsx';

export type SettingsSection =
  | 'connections'
  | 'identity'
  | 'installation'
  | 'notifications'
  | 'danger';

const SECTIONS = [
  { id: 'connections', label: 'Connections' },
  { id: 'identity', label: 'Identity' },
  { id: 'installation', label: 'Installation' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'danger', label: 'Danger zone' },
] as const satisfies readonly { id: SettingsSection; label: string }[];

export function SettingsLayout({
  section,
  onNavigate,
  children,
}: {
  readonly section: SettingsSection;
  readonly onNavigate: (path: string) => void;
  readonly children: ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <header>
        <Eyebrow>Administration</Eyebrow>
        <h1 className="mt-1 text-3xl font-semibold tracking-[-0.035em]">
          Settings
        </h1>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
          Connections and control-plane policy share one quiet administrative
          home.
        </p>
      </header>
      <div className="grid overflow-hidden rounded-sm border border-border bg-card lg:grid-cols-[230px_minmax(0,1fr)]">
        <aside className="border-b border-border p-3 lg:border-r lg:border-b-0 lg:p-5">
          <Eyebrow className="hidden lg:inline">Sections</Eyebrow>
          <Tabs
            variant="pill"
            label="Settings sections"
            items={SECTIONS}
            current={section}
            onSelect={(id) => onNavigate(`/settings/${id}`)}
            className="overflow-x-auto lg:mt-3 lg:flex-col lg:flex-nowrap lg:items-stretch"
          />
        </aside>
        <article className="min-w-0 p-4 sm:p-6 lg:p-8">{children}</article>
      </div>
    </div>
  );
}

export function EmptySettingsSection({
  eyebrow,
  title,
  children,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section>
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2 className="mt-1 text-2xl font-semibold tracking-tight">{title}</h2>
      <p className="mt-2 max-w-prose text-sm leading-6 text-muted-foreground">
        {children}
      </p>
    </section>
  );
}

export function SettingsScreen({
  path,
  onNavigate,
}: {
  path: string;
  onNavigate: (path: string) => void;
}) {
  const requested = path.replace(/^\/settings\/?/, '').split('/')[0] ?? '';
  const section: SettingsSection = [
    'connections',
    'identity',
    'installation',
    'notifications',
    'danger',
  ].includes(requested)
    ? (requested as SettingsSection)
    : 'connections';

  return (
    <SettingsLayout section={section} onNavigate={onNavigate}>
      {section === 'connections' ? (
        <ConnectionsSettings onNavigate={onNavigate} />
      ) : section === 'identity' ? (
        <div className="flex flex-col gap-6">
          <IdentitySettings />
          <AgentTokens />
        </div>
      ) : section === 'installation' ? (
        <InstallationSettings />
      ) : section === 'notifications' ? (
        <EmptySettingsSection
          eyebrow="Settings / notifications"
          title="Notifications"
        >
          No notification destinations are configured. Operational state stays
          visible in Overview until this installation gains a delivery command.
        </EmptySettingsSection>
      ) : (
        <EmptySettingsSection
          eyebrow="Settings / danger zone"
          title="Destructive controls"
        >
          Destructive acts remain beside the objects they affect, where their
          impact can be named precisely. There is no installation-wide delete.
        </EmptySettingsSection>
      )}
    </SettingsLayout>
  );
}

/**
 * Every external system this installation holds an address for, in supply
 * chain order.
 */
function ConnectionsSettings({
  onNavigate,
}: {
  readonly onNavigate: (path: string) => void;
}) {
  return (
    <section>
      <Eyebrow>Settings / connections</Eyebrow>
      <h2 className="mt-1 text-2xl font-semibold tracking-tight">
        Connected systems
      </h2>
      <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
        Every system outside Spindrift that Spindrift holds an address for. Each
        provider keeps its concrete state and actions in one ruled row, and the
        order is the supply chain: where code comes from, where a Source is
        staged, where a Source becomes an Artifact, where an Artifact is pushed,
        and where it runs.
      </p>
      <div className="mt-6 divide-y divide-border border-y border-border">
        <RepositoriesScreen embedded />
        <SourceBuckets />
        <Builders />
        <ArtifactRegistries />
        <TargetsScreen embedded onNavigate={onNavigate} />
      </div>
    </section>
  );
}
