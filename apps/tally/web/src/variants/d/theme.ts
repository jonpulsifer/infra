export {
  CAT_ORDER,
  cx,
  kmoney,
  money,
  type Palette,
  palette,
  pct,
  shortDate,
  signedMoney,
  tw,
} from '~/variants/a/theme';

export const SERIF = "'Iowan Old Style','Palatino Linotype',Georgia,serif";

export const CSS = `
@keyframes desk-in{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}
.dw-serif{font-family:${SERIF};font-feature-settings:'kern' 1,'liga' 1,'lnum' 1,'tnum' 1;font-variant-numeric:lining-nums tabular-nums}
.dw-prose{font-family:${SERIF};font-feature-settings:'kern' 1,'liga' 1;font-variant-numeric:lining-nums proportional-nums}
.dw-caps{font-variant-caps:all-small-caps;letter-spacing:.07em;font-size:12px;font-weight:600;line-height:14px}
.dw-drop::first-letter{font-family:${SERIF};float:left;font-size:3.35em;line-height:.8;padding:.07em .08em 0 0;font-weight:400}
@media (prefers-reduced-motion:reduce){[class*="animate-["]{animation:none!important}}
`;
