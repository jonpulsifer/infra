import { z } from 'zod';

/**
 * Everything the app knows about project slugs: their shape, which names are
 * reserved for the app's own routes, and how to recover a slug from a
 * pathname.
 *
 * This is the only place that knows a name is not available. The ingest route,
 * the project page, the create form, and the nav all ask this module rather
 * than each carrying their own list - four copies previously disagreed with
 * each other (the ingest route reserved "health" while the health route is
 * actually /api/healthz).
 */

/**
 * Top-level route segments the app serves itself. A project slug that
 * collided with one of these would be unreachable at `/{slug}`, and its
 * ingest endpoint would collide at `/api/{slug}`.
 */
export const RESERVED_SLUGS = [
  'api',
  'cache',
  'environment',
  'favicon.ico',
  'gcp',
  'headers',
  'health',
  'healthz',
  'jwt-decoder',
  'projects',
  'request-headers',
  'robots.txt',
  'sitemap.xml',
  'webhooks',
  '_next',
] as const;

const RESERVED = new Set<string>(RESERVED_SLUGS);

export function isReservedSlug(slug: string): boolean {
  return RESERVED.has(slug.toLowerCase());
}

/**
 * Slug shape:
 * - 1-32 characters
 * - lowercase letters, numbers, and hyphens only
 * - cannot start or end with a hyphen
 * - cannot be a reserved name
 */
export const slugSchema = z
  .string()
  .min(1, 'Slug is required')
  .max(32, 'Slug must be 32 characters or less')
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
    'Slug must contain only lowercase letters, numbers, and hyphens. Cannot start or end with a dash.',
  )
  .refine((value) => !isReservedSlug(value), {
    message: 'That name is reserved by Slingshot',
  });

/**
 * Coerce free-typed input toward a valid slug without rejecting it mid-word.
 * Leading/trailing hyphens survive here so a user can keep typing; the schema
 * rejects them on submit.
 */
export function normalizeSlugInput(input: string): string {
  return input
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 32);
}

/**
 * The project slug a pathname refers to, or null if the pathname belongs to
 * the app rather than to a project. Used for nav active state.
 */
export function projectSlugFromPathname(pathname: string): string | null {
  const segment = pathname.split('/')[1];
  if (!segment) {
    return null;
  }
  return isReservedSlug(segment) ? null : segment;
}
