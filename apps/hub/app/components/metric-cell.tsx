import { ChevronUp } from 'lucide-react';
import type { ReactNode } from 'react';
import type { MetricExtremes } from '~/lib/weatherflow/types';

/** Nullish checks only: `0` is a real reading, never missing data. */
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

export interface MetricCellProps {
  icon: ReactNode;
  label: string;
  /** This station holds the highest reading for this metric across the group. */
  isLeader?: boolean;
  /** Trailing content after the value, e.g. the barometric trend arrow. */
  trailing?: ReactNode;
  value?: number;
  unit?: string;
  decimals?: number;
  showUnitWhenEmpty?: boolean;
  locale?: boolean;
  /** Pre-formatted number text, bypassing formatMetricNumber. */
  displayText?: string;
  /** This metric's 24 h low and high, shown under the value. */
  range?: MetricExtremes;
}

/**
 * A caret marks the group leader, because the palette's hues identify stations
 * and a reading change must not recolour a panel.
 */
export function MetricCell({
  icon,
  label,
  isLeader = false,
  trailing,
  value,
  unit = '',
  decimals = 1,
  showUnitWhenEmpty = false,
  locale = false,
  displayText,
  range,
}: MetricCellProps) {
  const numberText =
    displayText ??
    formatMetricNumber(value, { decimals, showUnitWhenEmpty, locale });

  const rangeText = range
    ? `${formatMetricNumber(range.min, { decimals, locale })} – ${formatMetricNumber(
        range.max,
        { decimals, locale },
      )}`
    : null;

  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="flex items-center gap-1.5 text-slate-500">
        {icon}
        <span className="truncate text-[0.6rem] font-semibold uppercase tracking-[0.08em]">
          {label}
        </span>
      </span>
      <span className="flex items-baseline gap-1 truncate text-[1.05rem] font-bold tabular-nums text-white">
        {numberText}
        {unit && (
          <span className="text-[0.62rem] font-semibold text-slate-500">
            {unit}
          </span>
        )}
        {isLeader && (
          <ChevronUp
            className="h-3 w-3 shrink-0 text-slate-300"
            aria-label="highest of the compared stations"
          />
        )}
        {trailing}
      </span>
      {rangeText && (
        <span className="truncate text-[0.6rem] font-semibold tabular-nums text-slate-500">
          {rangeText}
        </span>
      )}
    </div>
  );
}
