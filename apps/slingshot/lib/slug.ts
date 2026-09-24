import { z } from 'zod';

// Project slugs: their shape, the names reserved for the app, and the slug a
// pathname names. Every reserved-name check goes through here.

// Names kept for the app's own paths under / and /api/, so no project is
// shadowed at /{slug} or /api/{slug}.
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

// Leading and trailing hyphens survive so the user can keep typing;
// slugSchema rejects them on submit.
export function normalizeSlugInput(input: string): string {
  return input
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 32);
}

// null for the root and for the app's own routes.
export function projectSlugFromPathname(pathname: string): string | null {
  const segment = pathname.split('/')[1];
  if (!segment) {
    return null;
  }
  return isReservedSlug(segment) ? null : segment;
}
