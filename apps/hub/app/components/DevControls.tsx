import { Minus, Plus } from 'lucide-react';

interface DevControlsProps {
  count: number;
  onAdd: () => void;
  onRemove: () => void;
}

/**
 * Dev-only floating panel to add/remove mock stations. Rendered only when the
 * weather hook reports it's running against mock data (`import.meta.env.DEV`),
 * so it never appears on a real display.
 */
export function DevControls({ count, onAdd, onRemove }: DevControlsProps) {
  const btn =
    'flex items-center justify-center w-7 h-7 rounded-full bg-gray-700 text-gray-200 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors';

  return (
    <div className="fixed bottom-3 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-full border border-gray-700 bg-gray-800/90 px-2 py-1 shadow-lg backdrop-blur">
      <span className="px-1.5 text-[10px] font-bold uppercase tracking-wider text-sky-400">
        Dev · mock
      </span>
      <button
        type="button"
        onClick={onRemove}
        disabled={count <= 0}
        aria-label="Remove a station"
        className={btn}
      >
        <Minus className="w-4 h-4" />
      </button>
      <span className="min-w-[5.5rem] text-center text-xs text-gray-300 tabular-nums">
        {count} station{count === 1 ? '' : 's'}
      </span>
      <button
        type="button"
        onClick={onAdd}
        aria-label="Add a station"
        className={btn}
      >
        <Plus className="w-4 h-4" />
      </button>
    </div>
  );
}
