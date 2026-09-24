// Nova Scotia's daily fire restrictions, read from the BurnSafe page. There is
// no API: the page's county table is the data, one `<tr id="<County>-County">`
// row per county with a `status-<level>` cell and the rule in a <p>.

export const BURNSAFE_URL = 'https://novascotia.ca/burnsafe/';

export type BurnRestriction = {
  county: string; // "Colchester"
  level: string; // burn, restricted, no-burn, or a level the page added
  label: string; // the hours burning is allowed, or the page's own wording
  updated?: string; // the page's "Last updated" text, e.g. "24 September 2026 at 2:00 pm"
};

// The levels the page's legend defines.
const LABELS: Record<string, string> = {
  burn: 'Burn 2 pm – 8 am',
  restricted: 'Burn 7 pm – 8 am',
  'no-burn': 'No burning',
};

const ROW =
  /<tr id="([\w-]+)-County">[\s\S]*?<td class="status-([\w-]+)">[\s\S]*?<p>([\s\S]*?)<\/p>/g;
const UPDATED = /Last updated:\s*([^<]+?)\s*</;

const tidy = (text: string) => text.replace(/\s+/g, ' ').trim();

// Keyed by county name with the page's hyphens turned back into spaces.
export function parseBurnSafe(html: string): Map<string, BurnRestriction> {
  const updated = html.match(UPDATED)?.[1];
  const counties = new Map<string, BurnRestriction>();
  for (const [, id, level, description] of html.matchAll(ROW)) {
    const county = id.replaceAll('-', ' ');
    counties.set(county, {
      county,
      level,
      label: LABELS[level] ?? tidy(description),
      ...(updated && { updated: tidy(updated) }),
    });
  }
  return counties;
}

// "201806=Colchester,176295=Halifax" -> station ID to county. A trailing
// " County" is accepted so the page's own names can be pasted in.
export function parseCountyMap(value: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const pair of value.split(',')) {
    const [station, county] = pair.split('=').map((s) => s.trim());
    const id = Number(station);
    if (!county || !Number.isFinite(id)) continue;
    map.set(id, county.replace(/[\s-]+County$/i, '').replaceAll('-', ' '));
  }
  return map;
}
