/**
 * The administrative rail, and the one tab strip left in this corner of the app.
 *
 * The rail was the third hand-rolled tab treatment in the tree: a column of
 * bare `<button>` elements each claiming to be the current *page*, with no
 * tablist around them and no way into the strip except Tab, Tab, Tab. These
 * entries do navigate, which is more than the other two strips could say — but a
 * tab navigating is still a tab, and `Tabs` is what the other two became, so
 * there is no reason left for this one to be its own thing. It keeps the
 * vertical column on wide screens purely through a class: the primitive owns
 * roving focus and the selected state, this file owns where the strip sits.
 *
 * `Danger zone` stays in the list. Its content is a paragraph explaining that the
 * category does not exist, which is a poor use of a fifth of the rail — but
 * `object-explorer.test.tsx` asserts all five labels and that file belongs to
 * another change in flight. Removing the entry and the assertion is one commit,
 * and it is not this one.
 */
import type { ReactNode } from 'react';
import { Eyebrow } from '../../ui/card.tsx';
import { Tabs } from '../../ui/tabs.tsx';

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
