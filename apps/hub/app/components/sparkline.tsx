import type { MetricExtremes } from '~/lib/weatherflow/types';

// Percentage of the box kept clear above and below the curve so the marker
// dots have room and the line never touches the edge.
const PAD = 12;

interface SparklineProps {
  /** [epoch seconds, value], oldest first. */
  points: Array<[number, number]>;
  /** The window's true low and high, which the curve is scaled against. */
  extremes?: MetricExtremes;
  accent: string;
  /** SVG gradient ids are document-global; one per rendered instance. */
  gradientId: string;
  label: string;
  className?: string;
}

function nearestIndex(points: Array<[number, number]>, at: number): number {
  let best = 0;
  let bestGap = Number.POSITIVE_INFINITY;
  points.forEach(([t], index) => {
    const gap = Math.abs(t - at);
    if (gap < bestGap) {
      bestGap = gap;
      best = index;
    }
  });
  return best;
}

/**
 * The 24h temperature curve under a station's headline reading.
 *
 * The SVG is drawn in a 0-100 box and stretched with
 * `preserveAspectRatio="none"` so it fills whatever width the panel has - which
 * is how the same component serves a 390px phone card and a 400px kiosk column
 * without measuring anything. `vector-effect="non-scaling-stroke"` keeps the
 * line an even 2px under that stretch, and the three markers are positioned as
 * HTML over the box rather than as SVG circles, which the stretch would squash
 * into ellipses.
 */
export function Sparkline({
  points,
  extremes,
  accent,
  gradientId,
  label,
  className,
}: SparklineProps) {
  if (points.length < 2) {
    return (
      <div
        className={`${className ?? ''} rounded bg-white/[0.03]`}
        aria-hidden="true"
      />
    );
  }

  const values = points.map(([, value]) => value);
  const low = extremes?.min ?? Math.min(...values);
  const high = extremes?.max ?? Math.max(...values);
  const span = high - low || 1;

  const x = (index: number) => (index / (points.length - 1)) * 100;
  const y = (value: number) =>
    PAD + (1 - (value - low) / span) * (100 - 2 * PAD);

  const line = points
    .map(([, value], index) => {
      const command = index === 0 ? 'M' : 'L';
      return `${command}${x(index).toFixed(2)} ${y(value).toFixed(2)}`;
    })
    .join(' ');

  const highIndex = extremes
    ? nearestIndex(points, extremes.maxAt)
    : values.indexOf(high);
  const lowIndex = extremes
    ? nearestIndex(points, extremes.minAt)
    : values.indexOf(low);

  const markers = [
    { key: 'high', index: highIndex, value: high, ring: accent },
    { key: 'low', index: lowIndex, value: low, ring: '#5D7E9B' },
    {
      key: 'now',
      index: points.length - 1,
      value: values[values.length - 1],
      ring: null,
    },
  ];

  return (
    <div className={`relative ${className ?? ''}`}>
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="h-full w-full"
        role="img"
        aria-label={label}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={accent} stopOpacity="0.34" />
            <stop offset="1" stopColor={accent} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <path d={`${line} L100 100 L0 100 Z`} fill={`url(#${gradientId})`} />
        <path
          d={line}
          fill="none"
          stroke={accent}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {markers.map((marker) => (
        <span
          key={marker.key}
          aria-hidden="true"
          className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            left: `${x(marker.index)}%`,
            top: `${y(marker.value)}%`,
            background: marker.ring ? '#0b0f15' : '#E6ECF3',
            border: marker.ring ? `2px solid ${marker.ring}` : 'none',
            boxShadow: marker.ring ? undefined : '0 0 0 2px #0b0f15',
          }}
        />
      ))}
    </div>
  );
}
