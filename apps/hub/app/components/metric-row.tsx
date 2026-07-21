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
    isDiff = false,
    showUnitWhenEmpty = false,
  }: {
    decimals?: number;
    unit?: string;
    isDiff?: boolean;
    showUnitWhenEmpty?: boolean;
  } = {},
): string {
  if (value == null) {
    return showUnitWhenEmpty ? `--${unit}` : '--';
  }
  const sign = isDiff && value > 0 ? '+' : '';
  return `${sign}${value.toFixed(decimals)}${unit}`;
}

/**
 * Color a metric's value by sign when rendering a diff view; otherwise use
 * the row's neutral color. Nullish-safe throughout.
 */
export function getDiffColorClass(
  value: number | undefined,
  isDiff: boolean,
  {
    positive = 'text-red-400',
    negative = 'text-blue-400',
    neutral = 'text-white',
    undefinedClass = neutral,
  }: {
    positive?: string;
    negative?: string;
    neutral?: string;
    undefinedClass?: string;
  } = {},
): string {
  if (value == null) return undefinedClass;
  if (!isDiff) return neutral;
  if (value > 0) return positive;
  if (value < 0) return negative;
  return neutral;
}

export interface MetricRowProps {
  icon: ReactNode;
  label: string;
  isDiff?: boolean;
  /** font-bold vs font-semibold - matches the two weights used across rows */
  weight?: 'bold' | 'semibold';
  labelClassName?: string;
  neutralClassName?: string;
  undefinedClassName?: string;
  /** Extra content rendered after the value, e.g. a unit badge and/or trend icon (pressure). */
  trailing?: ReactNode;
  // Simple formatting path - covers every row except ones with bespoke
  // empty/zero text (e.g. "Windless"), which pass `displayText` instead.
  value?: number;
  unit?: string;
  decimals?: number;
  showUnitWhenEmpty?: boolean;
  /** Escape hatch: pre-formatted text, bypassing the simple formatting path. */
  displayText?: string;
}

/**
 * One row in the station weather grid: icon, label, value (colored by sign
 * when isDiff), optional trailing content (unit badge, trend icon).
 */
export function MetricRow({
  icon,
  label,
  isDiff = false,
  weight = 'bold',
  labelClassName = 'text-gray-400',
  neutralClassName = 'text-white',
  undefinedClassName = neutralClassName,
  trailing,
  value,
  unit = '',
  decimals = 1,
  showUnitWhenEmpty = false,
  displayText,
}: MetricRowProps) {
  const text =
    displayText ??
    formatMetricNumber(value, { decimals, unit, isDiff, showUnitWhenEmpty });

  const color = getDiffColorClass(value, isDiff, {
    neutral: neutralClassName,
    undefinedClass: undefinedClassName,
  });

  const weightClass = weight === 'bold' ? 'font-bold' : 'font-semibold';

  return (
    <div className="flex items-center justify-between px-2 py-0.5 border-b border-gray-800 flex-shrink-0 min-h-[1.75rem]">
      <div className="flex items-center gap-2">
        {icon}
        {!isDiff && (
          <span className={`text-sm ${labelClassName}`}>{label}</span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className={`text-lg ${weightClass} ${color}`}>{text}</span>
        {trailing}
      </div>
    </div>
  );
}
