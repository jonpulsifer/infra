import type { ReactNode } from 'react';

/**
 * Format a metric's numeric value for display.
 *
 * Deepens what used to be a hand-written `!= null` (and, in one place, a
 * bare truthy check) plus sign-prefixing plus unit-suffixing repeated
 * near-verbatim at every call site in StationDisplay. Always uses nullish
 * checks - `0` is a legitimate value, never a "missing data" signal.
 */
export function formatMetricNumber(
  value: number | undefined,
  {
    decimals = 1,
    unit = '',
    isDiff = false,
    showUnitWhenEmpty = false,
    emptyText = '--',
  }: {
    decimals?: number;
    unit?: string;
    isDiff?: boolean;
    showUnitWhenEmpty?: boolean;
    emptyText?: string;
  } = {},
): string {
  if (value == null) {
    return showUnitWhenEmpty ? `${emptyText}${unit}` : emptyText;
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
  isSingleStation?: boolean;
  /** font-bold vs font-semibold - matches the two weights used across rows */
  weight?: 'bold' | 'semibold';
  labelClassName?: string;
  neutralClassName?: string;
  undefinedClassName?: string;
  /** Content shown below the value, e.g. a caption. Left as a generic slot
   * (rather than a hardcoded min/max shape) since no metric currently has
   * real min/max data to show - see PR description. */
  subtext?: ReactNode;
  /** Extra content rendered after the value, e.g. a unit badge and/or trend icon (pressure). */
  trailing?: ReactNode;
  // Simple formatting path - covers every row except ones with bespoke
  // empty/zero text (e.g. "Windless"), which pass `displayText` instead.
  value?: number;
  unit?: string;
  decimals?: number;
  showUnitWhenEmpty?: boolean;
  emptyText?: string;
  /** Escape hatch: pre-formatted text, bypassing the simple formatting path. */
  displayText?: string;
  /** Escape hatch: pre-computed color class, bypassing getDiffColorClass. */
  colorClassName?: string;
}

/**
 * One row in the station weather grid: icon, label, value (colored by sign
 * when isDiff), optional trailing content (unit badge, trend icon), optional
 * subtext caption. Replaces 9 near-duplicate blocks in StationDisplay that
 * each hand-rolled this same value/color/unit pattern with inconsistent
 * null-checks.
 */
export function MetricRow({
  icon,
  label,
  isDiff = false,
  isSingleStation = false,
  weight = 'bold',
  labelClassName = 'text-gray-400',
  neutralClassName = 'text-white',
  undefinedClassName = neutralClassName,
  subtext,
  trailing,
  value,
  unit = '',
  decimals = 1,
  showUnitWhenEmpty = false,
  emptyText = '--',
  displayText,
  colorClassName,
}: MetricRowProps) {
  const text =
    displayText ??
    formatMetricNumber(value, {
      decimals,
      unit,
      isDiff,
      showUnitWhenEmpty,
      emptyText,
    });

  const color =
    colorClassName ??
    getDiffColorClass(value, isDiff, {
      neutral: neutralClassName,
      undefinedClass: undefinedClassName,
    });

  const weightClass = weight === 'bold' ? 'font-bold' : 'font-semibold';

  return (
    <div
      className={`flex items-center justify-between px-2 py-0.5 border-b border-gray-800 ${
        isSingleStation ? 'border-r border-r-gray-800' : ''
      } flex-shrink-0 min-h-[1.75rem]`}
    >
      <div className="flex items-center gap-2">
        {icon}
        {!isDiff && (
          <span className={`text-sm ${labelClassName}`}>{label}</span>
        )}
      </div>
      <div className="flex flex-col items-end min-h-[1.75rem] justify-center">
        <div className="flex items-center gap-2">
          <span className={`text-lg ${weightClass} ${color}`}>{text}</span>
          {trailing}
        </div>
        {subtext && <div className="text-xs text-gray-500">{subtext}</div>}
      </div>
    </div>
  );
}
