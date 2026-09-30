/**
 * Nova Scotia's daily burn restrictions. The BurnSafe page has no API: its
 * county table is the data, one `<tr id="<County>-County">` row per county
 * with a `status-<level>` cell and the rule in a <p>.
 */
import type { Upstream } from './upstream.ts';

export const BURNSAFE_URL = 'https://novascotia.ca/burnsafe/';

export interface BurnRestriction {
  county: string;
  level: string;
  rule: string;
}

export interface BurnSafe {
  updated?: string;
  counties: BurnRestriction[];
  source: string;
}

// The levels the page's legend defines.
const RULES: Record<string, string> = {
  burn: 'Burning allowed 2 pm to 8 am',
  restricted: 'Burning allowed 7 pm to 8 am',
  'no-burn': 'No burning',
};

const ROW =
  /<tr id="([\w-]+)-County">[\s\S]*?<td class="status-([\w-]+)">[\s\S]*?<p>([\s\S]*?)<\/p>/g;
const UPDATED = /Last updated:\s*([^<]+?)\s*</;

const tidy = (text: string) =>
  text
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function parseBurnSafe(html: string): BurnSafe {
  const updated = html.match(UPDATED)?.[1];
  const counties = [...html.matchAll(ROW)].map(([, id, level, text]) => ({
    county: (id ?? '').replaceAll('-', ' '),
    level: level ?? 'unknown',
    rule: RULES[level ?? ''] ?? tidy(text ?? ''),
  }));
  return {
    ...(updated && { updated: tidy(updated) }),
    counties,
    source: BURNSAFE_URL,
  };
}

/** The page changes at 8 am and 2 pm, so ten minutes stale is fine. */
export async function burnSafe(
  upstream: Upstream,
  county?: string,
): Promise<BurnSafe> {
  const page = parseBurnSafe(await upstream.text(BURNSAFE_URL, 10 * 60_000));
  if (page.counties.length === 0) {
    throw new Error('the BurnSafe page has no county rows; its layout changed');
  }
  if (!county) return page;
  const wanted = county
    .toLowerCase()
    .replace(/[\s-]+county$/, '')
    .replaceAll('-', ' ')
    .trim();
  const match = page.counties.filter((c) => c.county.toLowerCase() === wanted);
  if (match.length === 0) {
    throw new Error(
      `no Nova Scotia county named ${county}; counties: ${page.counties.map((c) => c.county).join(', ')}`,
    );
  }
  return { ...page, counties: match };
}
