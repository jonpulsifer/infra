import type { ReactNode } from 'react';
import { Eyebrow } from '../../ui/card.tsx';
import { cn } from '../../ui/utils.ts';

export type SettingsSection =
  | 'connections'
  | 'identity'
  | 'installation'
  | 'artifacts'
  | 'notifications'
  | 'danger';

const SECTIONS = [
  { id: 'connections', label: 'Connections' },
  { id: 'identity', label: 'Identity' },
  { id: 'installation', label: 'Installation' },
  { id: 'artifacts', label: 'Artifact policy' },
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
          <nav
            aria-label="Settings sections"
            className="flex gap-1 overflow-x-auto lg:mt-3 lg:flex-col"
          >
            {SECTIONS.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-current={section === item.id ? 'page' : undefined}
                onClick={() => onNavigate(`/settings/${item.id}`)}
                className={cn(
                  'shrink-0 rounded-sm px-3 py-2 text-left text-sm transition-colors',
                  section === item.id
                    ? 'bg-secondary font-semibold text-foreground'
                    : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                )}
              >
                {item.label}
              </button>
            ))}
          </nav>
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
