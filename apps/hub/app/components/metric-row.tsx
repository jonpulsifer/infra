import type { ReactNode } from 'react';

/**
 * Format a metric's numeric value for display. Always uses nullish checks -
 * `0` is a legitimate value, never a "missing data" signal.
 */
export function formatMetricNumber(
  value: number | undefined,
  {
    decimals = 1,
    unit = '',
    showUnitWhenEmpty = false,
    locale = false,
  }: {
    decimals?: number;
    unit?: string;
    showUnitWhenEmpty?: boolean;
    /** Thousands-separate the value (e.g. lux). */
    locale?: boolean;
  } = {},
): string {
  if (value == null) {
    return showUnitWhenEmpty ? `--${unit}` : '--';
  }
  const num = locale
    ? value.toLocaleString(undefined, { maximumFractionDigits: decimals })
    : value.toFixed(decimals);
  return `${num}${unit}`;
}

export interface MetricRowProps {
  icon: ReactNode;
  label: string;
  /** Muted context beside the label, e.g. wind direction + gust. */
  sub?: string;
  /** This station holds the highest reading for this metric across the group. */
  isLeader?: boolean;
  /** Trailing content after the value, e.g. the barometric trend arrow. */
  trailing?: ReactNode;
  value?: number;
  unit?: string;
  decimals?: number;
  showUnitWhenEmpty?: boolean;
  locale?: boolean;
  /** Escape hatch: pre-formatted number text, bypassing formatMetricNumber. */
  displayText?: string;
}

/**
 * One row in a station panel: icon + label (with optional sub-context) on the
 * left, value on the right. The value becomes an accent pill when this station
 * leads the metric across the compared group. Rows use `flex-1` so a panel's
 * rows share its full height edge-to-edge.
 */
export function MetricRow({
  icon,
  label,
  sub,
  isLeader = false,
  trailing,
  value,
  unit = '',
  decimals = 1,
  showUnitWhenEmpty = false,
  locale = false,
  displayText,
}: MetricRowProps) {
  const numberText =
    displayText ??
    formatMetricNumber(value, { decimals, showUnitWhenEmpty, locale });

  return (
    <div className="flex-1 min-h-[2.1rem] flex items-center justify-between gap-2.5 border-b border-white/[0.07] last:border-b-0">
      <span className="flex items-center gap-2.5 min-w-0 text-slate-400">
        {icon}
        <span className="text-[0.72rem] font-semibold whitespace-nowrap">
          {label}
        </span>
        {sub && (
          <span className="text-[0.6rem] text-slate-500 font-semibold whitespace-nowrap truncate">
            {sub}
          </span>
        )}
      </span>
      <span
        className={`text-[1.05rem] font-bold tabular-nums whitespace-nowrap inline-flex items-center gap-1.5 ${
          isLeader
            ? 'text-sky-400 bg-sky-400/15 px-2.5 py-0.5 rounded-full'
            : 'text-white'
        }`}
      >
        {numberText}
        {unit && (
          <span
            className={`text-[0.66rem] font-semibold ${
              isLeader ? 'text-sky-300/70' : 'text-slate-500'
            }`}
          >
            {unit}
          </span>
        )}
        {trailing}
      </span>
    </div>
  );
}
