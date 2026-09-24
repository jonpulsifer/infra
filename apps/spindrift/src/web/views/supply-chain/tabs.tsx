/**
 * The Sources, Builds and Artifacts tabs under one supply chain nav entry, and
 * the chain diagram each of those screens renders below its ledger.
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

export function SupplyChainFlow() {
  return (
    <Flow
      src={supplyChainFlow}
      label="How a Source becomes something that is serving"
      alt="Source and Build produce an Artifact through one BuildKit program on any of three routes; the gate verifies, caps the level and signs; the Artifact plus pinned config references becomes a Deploy, admitted by a signature check."
    />
  );
}
