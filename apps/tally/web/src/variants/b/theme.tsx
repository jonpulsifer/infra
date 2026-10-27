// Tokens for the Editorial variant. Colours live as CSS custom properties on
// the variant root so SVG marks and Tailwind classes read the same values,
// and `.dark` on <html> swaps them in one place.

export const SERIF =
  "'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif";

const LIGHT = `
  color-scheme: light;
  --page: #fcfcfb;
  --raise: #ffffff;
  --sunk: #f3f2ee;
  --ink: #0b0b0b;
  --ink2: #52514e;
  --muted: #6c6b66;
  --faint: #898781;
  --grid: #e8e7e1;
  --axis: #c3c2b7;
  --hair: rgba(11, 11, 11, 0.1);
  --wash: rgba(11, 11, 11, 0.04);
  --s1: #2a78d6;
  --s2: #eb6834;
  --s3: #1baf7a;
  --s4: #eda100;
  --s5: #e87ba4;
  --s6: #008300;
  --s7: #6250d6;
  --flow: #b9b8b0;
  --good: #006300;
  --bad: #c03434;
  --focus: #2a78d6;
`;

const DARK = `
  color-scheme: dark;
  --page: #1a1a19;
  --raise: #222221;
  --sunk: #141413;
  --ink: #f0efec;
  --ink2: #c3c2b7;
  --muted: #a3a29a;
  --faint: #898781;
  --grid: #2c2c2a;
  --axis: #45453f;
  --hair: rgba(255, 255, 255, 0.1);
  --wash: rgba(255, 255, 255, 0.05);
  --s1: #3987e5;
  --s2: #d95926;
  --s3: #199e70;
  --s4: #c98500;
  --s5: #d55181;
  --s6: #0ca30c;
  --s7: #9085e9;
  --flow: #5d5c56;
  --good: #3ac43a;
  --bad: #f07a7a;
  --focus: #6da7ec;
`;

const CSS = `
.vb { ${LIGHT} }
.dark .vb { ${DARK} }
.vb { background: var(--page); color: var(--ink); }
.vb .serif { font-family: ${SERIF}; font-feature-settings: 'kern' 1, 'liga' 1; }
.vb .num { font-variant-numeric: tabular-nums; }
.vb ::selection { background: color-mix(in srgb, var(--s1) 25%, transparent); }
.vb :focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: 6px; }
.vb .halo { paint-order: stroke; stroke: var(--page); stroke-width: 4px; stroke-linejoin: round; }
.vb .dropcap::first-letter {
  font-family: ${SERIF};
  float: left;
  font-size: 4.1em;
  line-height: 0.82;
  padding: 0.06em 0.09em 0 0;
  color: var(--ink);
}
/* The root toggles .dark after mount; skip colour transitions until then. */
.vb.vb-boot, .vb.vb-boot * { transition: none !important; }
@keyframes vb-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.vb .vb-in { animation: vb-in 0.35s cubic-bezier(.2,.7,.2,1) both; }
@media (prefers-reduced-motion: reduce) { .vb .vb-in { animation: none; } }
`;

export function ThemeStyle() {
  return <style>{CSS}</style>;
}

/** Top-level spend groups in fixed categorical order; colour follows the group. */
export const GROUP_ORDER = [
  'housing',
  'food',
  'transport',
  'living',
  'fun',
  'uncategorized',
];

export function groupColor(groupId: string): string {
  if (groupId === 'saved') return 'var(--s6)';
  const i = GROUP_ORDER.indexOf(groupId);
  return i >= 0 && i < 5 ? `var(--s${i + 1})` : 'var(--faint)';
}
