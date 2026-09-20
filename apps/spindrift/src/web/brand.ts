/**
 * What the product is called, in the one place the console reads it from.
 *
 * The name reaches a person six ways: the wordmark on the rail and the two
 * signed-out screens, the root of the breadcrumb trail, every tab's title, the
 * footer's version line, the small print under a status page, and the name the
 * MCP endpoint gives an agent. Each of
 * those once spelled the word out for itself, so a change to the name was a
 * search across the tree with no way to know it had finished.
 *
 * Only what a person or an agent is *told* lives here. A storage key, an event
 * name and an environment variable are identifiers: nothing reads them as the
 * product's name, and changing one breaks whatever already holds the old value.
 *
 * No imports, on purpose: the browser bundle and the server's MCP route both
 * read this file, and neither may drag the other's module graph in.
 */

/** The name in running prose: tab titles, the footer, accessible labels. */
export const PRODUCT_NAME = 'kthx';

/**
 * The name as the wordmark draws it — lower-case, the way kthx's own landing
 * sets it (`packages/kthx/landing.html`'s `.big`) and its console mock does
 * (`app-shell.tsx`'s `Wordmark`). It is the same word as {@link PRODUCT_NAME}
 * now that the console wears the product's own brand rather than typing it in
 * capitals, which is why the two constants read identically here.
 */
export const WORDMARK = 'kthx';

/** The one letter the collapsed rail has room for. */
export const WORDMARK_GLYPH = 'k';

/**
 * The name a machine is given: the MCP endpoint's `serverInfo.name`.
 *
 * Deliberately unchanged. What an agent's tool list calls this deployment is a
 * protocol identifier a client may already be pinned to, and renaming it is a
 * separate, breaking decision from renaming the chrome a person reads — not
 * one this file's brand pass makes for free.
 */
export const MACHINE_NAME = 'spindrift';

/** A tab's title: the page, then the product; the product alone at the root. */
export function pageTitle(page?: string): string {
  return page === undefined ? PRODUCT_NAME : `${page} · ${PRODUCT_NAME}`;
}
