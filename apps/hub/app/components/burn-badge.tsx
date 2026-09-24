import { Flame } from 'lucide-react';
import type { BurnRestriction } from '~/lib/burnsafe';

const LEVEL_TONE: Record<string, string> = {
  burn: 'text-emerald-400',
  restricted: 'text-amber-400',
  'no-burn': 'text-red-400',
};

export function BurnBadge({ burn }: { burn: BurnRestriction }) {
  const tone = LEVEL_TONE[burn.level] ?? 'text-slate-400';
  return (
    <div
      className="flex min-w-0 shrink-0 items-center gap-1.5 text-[0.72rem] font-semibold"
      title={burn.updated ? `As of ${burn.updated}` : undefined}
    >
      <Flame className={`h-3.5 w-3.5 shrink-0 ${tone}`} aria-hidden="true" />
      <span className={`whitespace-nowrap ${tone}`}>{burn.label}</span>
      <span className="truncate text-[0.6rem] uppercase tracking-wide text-slate-500">
        {burn.county} County
      </span>
    </div>
  );
}
