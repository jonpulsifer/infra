/**
 * The supply chain, as three surfaces on one nav entry.
 *
 * §2's object model reads left to right — **Source + Build = Artifact**, then
 * **Artifact + Config = Deploy** — and the two nouns in that sentence used to
 * have nowhere to be. A Source appeared only as a "bundle" section on a
 * Settings screen about storage, and an Artifact appeared only as columns on
 * the Build that produced it, which is why the same staged bytes could be read
 * as a bundle in one place and an artifact in another.
 *
 * They are peers of Builds rather than a fourth and fifth rail entry because
 * the thing an operator navigates to is the chain, and the tab is which term of
 * it they are looking at. Deploy stays top-level: it is the act that puts
 * something in front of users, and §18's "the running app is the product" is
 * the whole reason it does not read as the last stage of a pipeline.
 *
 * The tabs are plain links into the existing routes, so `/builds` and
 * `/builds/<id>` keep meaning exactly what they meant.
 */
import { Eyebrow } from '../../ui/card.tsx';
import { cn } from '../../ui/utils.ts';

export type SupplyChainTab = 'sources' | 'builds' | 'artifacts';

const TABS = [
  { id: 'sources', label: 'Sources', path: '/sources' },
  { id: 'builds', label: 'Builds', path: '/builds' },
  { id: 'artifacts', label: 'Artifacts', path: '/artifacts' },
] as const satisfies readonly {
  id: SupplyChainTab;
  label: string;
  path: string;
}[];

export function SupplyChainTabs({
  current,
  onNavigate,
}: {
  readonly current: SupplyChainTab;
  readonly onNavigate: (path: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Eyebrow>Supply chain</Eyebrow>
      <nav
        aria-label="Supply chain"
        className="flex gap-1 rounded-sm border border-border bg-card p-1"
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            aria-current={current === tab.id ? 'page' : undefined}
            onClick={() => onNavigate(tab.path)}
            className={cn(
              'rounded-sm px-3 py-1.5 text-sm transition-colors',
              current === tab.id
                ? 'bg-secondary font-semibold text-foreground'
                : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
            )}
          >
            {tab.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
