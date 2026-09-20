import type { MetricExtremes } from '~/lib/weatherflow/types';

interface RangeBarProps {
  extremes: MetricExtremes;
  /** Current reading, drawn as the marker. Omitted leaves the track bare. */
  value?: number;
  format: (value: number) => string;
  /** Matches the panel's card colour so the marker's ring reads as a cutout. */
  ringColor?: string;
}

const clockTime = (epochSeconds: number) =>
  new Date(epochSeconds * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

/**
 * Where the current temperature sits inside the last 24 hours: a cold-to-warm
 * track running from the window's low to its high, with the reading marked on
 * it. The gradient is a temperature scale, not a station colour - it means the
 * same thing in every panel.
 */
export function RangeBar({
  extremes,
  value,
  format,
  ringColor = '#10151d',
}: RangeBarProps) {
  const span = extremes.max - extremes.min || 1;
  // A reading fractionally outside its own window (the latest observation is
  // newer than the last history refresh) pins to the end rather than escaping.
  const position =
    value == null
      ? null
      : Math.min(100, Math.max(0, ((value - extremes.min) / span) * 100));

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[0.6rem] font-semibold uppercase tracking-[0.1em] text-slate-500">
          Last 24h
        </span>
        <span className="text-[0.7rem] font-semibold tabular-nums text-slate-400">
          {format(extremes.min)} – {format(extremes.max)}
        </span>
      </div>
      <div className="relative h-2.5 rounded-full bg-gradient-to-r from-[#2A93CC] via-[#5D7E9B] to-[#CC7E2F]">
        {position != null && (
          <span
            aria-hidden="true"
            className="absolute -top-1 h-[1.125rem] w-[1.125rem] -translate-x-1/2 rounded-full bg-[#E6ECF3]"
            style={{
              left: `${position}%`,
              border: `4px solid ${ringColor}`,
            }}
          />
        )}
      </div>
      <div className="flex justify-between text-[0.6rem] tabular-nums text-slate-500">
        <span>{clockTime(extremes.minAt)}</span>
        <span>{clockTime(extremes.maxAt)}</span>
      </div>
    </div>
  );
}
