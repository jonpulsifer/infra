/**
 * The product's name wherever a person or an agent reads it. Storage keys,
 * event names and environment variables stay out. No imports: the browser
 * bundle and the server's MCP route both read this file.
 */

/** The name in running prose: tab titles, the footer, accessible labels. */
export const PRODUCT_NAME = 'kthx';

/** The name as the wordmark draws it, always lower-case. */
export const WORDMARK = 'kthx';

/** The one letter the collapsed rail has room for. */
export const WORDMARK_GLYPH = 'k';

/**
 * The MCP endpoint's `serverInfo.name`. Clients may pin it, so renaming it
 * breaks them.
 */
export const MACHINE_NAME = 'spindrift';

export function pageTitle(page?: string): string {
  return page === undefined ? PRODUCT_NAME : `${page} · ${PRODUCT_NAME}`;
}
