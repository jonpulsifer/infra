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
 *
 * Two things moved out of this component and the reason is the same for both:
 * everything above the first row of data is a toll the operator pays on every
 * visit. The `Supply chain` eyebrow is gone because the strip beneath it said
 * the same word twice — it is now the strip's own accessible name, which is
 * where a label belongs when the thing it labels is already legible. And
 * {@link SupplyChainFlow} is exported separately so each screen can render the
 * diagram *below* its ledger; `components/flow.tsx` already concedes that "the
 * operator came for the rows", and documentation stacked on top of the rows is
 * the one place it helps nobody.
 */
import supplyChainFlow from '../../client/diagrams/supply-chain.svg';
import { Flow } from '../../components/flow.tsx';
import { Tabs } from '../../ui/tabs.tsx';

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
    <Tabs
      label="Supply chain"
      items={TABS}
      current={current}
      onSelect={(id) => {
        const tab = TABS.find((candidate) => candidate.id === id);
        if (tab) onNavigate(tab.path);
      }}
    />
  );
}

/** The chain as a picture, for the reader who has not built the model yet. */
export function SupplyChainFlow() {
  return (
    <Flow
      src={supplyChainFlow}
      label="How a Source becomes something that is serving"
      alt="Source and Build produce an Artifact through one BuildKit program on any of three routes; the gate verifies, caps the level and signs; the Artifact plus pinned config references becomes a Deploy, admitted by a signature check."
    />
  );
}
