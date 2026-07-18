import { eq } from 'drizzle-orm';
import { getSetting } from './actions';
import { db, hosts, profiles } from './db';
import {
  buildTemplateContext,
  localBootScript,
  normalizeMac,
  processTemplate,
  unregisteredHostScript,
} from './ipxe';

interface RequestLike {
  headers: { get(name: string): string | null };
}

/**
 * Derive the base URL used for template variables like {{base_url}} and
 * {{server_ip}}. Prefers the configured `serverOrigin` setting; falls back
 * to the incoming request's forwarded/host headers.
 *
 * This was previously duplicated near-verbatim in both the boot route and
 * the scripts route.
 */
export function resolveServerOrigin(
  request: RequestLike,
  configuredOrigin: string | null,
): string {
  const host =
    configuredOrigin ||
    request.headers.get('x-forwarded-host') ||
    request.headers.get('host') ||
    'localhost:3000';
  const protocol = request.headers.get('x-forwarded-proto') || 'http';

  return configuredOrigin || `${protocol}://${host}`;
}

async function getDefaultProfile() {
  return db.select().from(profiles).where(eq(profiles.isDefault, true)).get();
}

/**
 * Resolve the full iPXE boot script for a MAC address.
 *
 * Owns the entire boot-resolution pipeline that was previously inlined in
 * the boot route handler: host lookup, auto-registration of unknown hosts
 * (when enabled), profile fallback to the default profile, and template
 * rendering. Callers only need a normalized-or-not MAC and a base URL.
 */
export async function resolveBootScript(
  mac: string,
  serverOrigin: string,
): Promise<string> {
  const normalizedMac = normalizeMac(mac);
  const now = new Date().toISOString();

  let host = await db
    .select()
    .from(hosts)
    .where(eq(hosts.macAddress, normalizedMac))
    .get();

  if (!host) {
    const autoRegister = (await getSetting('autoRegisterHosts')) !== 'false'; // default true

    if (!autoRegister) {
      return unregisteredHostScript(normalizedMac);
    }

    await db.insert(hosts).values({
      macAddress: normalizedMac,
      lastSeen: now,
      createdAt: now,
      updatedAt: now,
    });

    host = await db
      .select()
      .from(hosts)
      .where(eq(hosts.macAddress, normalizedMac))
      .get();
  } else {
    await db
      .update(hosts)
      .set({ lastSeen: now, updatedAt: now })
      .where(eq(hosts.macAddress, normalizedMac));
  }

  // Fall back to the default profile when the host has none assigned.
  let profile = host?.profileId
    ? await db
        .select()
        .from(profiles)
        .where(eq(profiles.id, host.profileId))
        .get()
    : null;

  if (!profile) {
    profile = await getDefaultProfile();
  }

  if (!profile) {
    return localBootScript(normalizedMac);
  }

  const context = buildTemplateContext(
    normalizedMac,
    host ?? null,
    profile,
    serverOrigin,
  );

  return processTemplate(profile.content, context);
}
