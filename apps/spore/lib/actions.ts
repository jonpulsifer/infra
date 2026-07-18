'use server';

import { desc, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { makeCrudActions } from './crud';
import { db, hosts, profiles, scripts, settings } from './db';
import type { NewHost, NewProfile, NewScript } from './db/schema';
import { normalizeMac } from './ipxe';

// ============================================================================
// Hosts
// ============================================================================

const hostCrud = makeCrudActions<
  Pick<NewHost, 'macAddress' | 'hostname' | 'profileId'>,
  Partial<Pick<NewHost, 'hostname' | 'profileId'>>,
  string
>({
  table: hosts,
  idColumn: hosts.macAddress,
  paths: (mac) =>
    mac
      ? ['/hosts', `/hosts/${encodeURIComponent(mac)}`, '/']
      : ['/hosts', '/'],
});

export async function getHosts() {
  return db.select().from(hosts).orderBy(desc(hosts.lastSeen));
}

export async function getHost(macAddress: string) {
  const normalized = normalizeMac(macAddress);
  return db.select().from(hosts).where(eq(hosts.macAddress, normalized)).get();
}

export async function createHost(data: {
  macAddress: string;
  hostname?: string;
  profileId?: number;
}) {
  const normalized = normalizeMac(data.macAddress);

  await hostCrud.create({
    macAddress: normalized,
    hostname: data.hostname || null,
    profileId: data.profileId || null,
  });
}

export async function updateHost(
  macAddress: string,
  data: Partial<Pick<NewHost, 'hostname' | 'profileId'>>,
) {
  const normalized = normalizeMac(macAddress);
  await hostCrud.update(normalized, data);
}

export async function deleteHost(macAddress: string) {
  const normalized = normalizeMac(macAddress);
  await hostCrud.remove(normalized);
}

// ============================================================================
// Profiles
// ============================================================================

// Profiles have an extra invariant (at most one default profile) that
// doesn't fit the generic create/update shape, so they don't use
// `makeCrudActions` directly for writes. The factory is still used here
// purely to keep the revalidation paths declared in one place.
const profileCrud = makeCrudActions<never, never, number>({
  table: profiles,
  idColumn: profiles.id,
  paths: (id) =>
    id ? ['/profiles', `/profiles/${id}`, '/'] : ['/profiles', '/'],
});

export async function getProfiles() {
  return db.select().from(profiles).orderBy(desc(profiles.updatedAt));
}

export async function getProfile(id: number) {
  return db.select().from(profiles).where(eq(profiles.id, id)).get();
}

export async function createProfile(
  data: Pick<NewProfile, 'name' | 'description' | 'content' | 'isDefault'>,
) {
  const now = new Date().toISOString();

  // Unset any existing default and insert the new profile atomically, so two
  // concurrent create/update(isDefault: true) calls can't both leave a
  // default set (or race and leave zero/two defaults).
  const inserted = db.transaction((tx) => {
    if (data.isDefault) {
      tx.update(profiles).set({ isDefault: false }).run();
    }

    return tx
      .insert(profiles)
      .values({
        name: data.name,
        description: data.description || null,
        content: data.content,
        isDefault: data.isDefault || false,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: profiles.id })
      .get();
  });

  profileCrud.revalidate();

  return inserted;
}

export async function updateProfile(
  id: number,
  data: Partial<
    Pick<NewProfile, 'name' | 'description' | 'content' | 'isDefault'>
  >,
) {
  const now = new Date().toISOString();

  // Same atomicity concern as createProfile: unset-then-set must happen in
  // one transaction so it can't race with a concurrent default change.
  db.transaction((tx) => {
    if (data.isDefault) {
      tx.update(profiles).set({ isDefault: false }).run();
    }

    tx.update(profiles)
      .set({ ...data, updatedAt: now })
      .where(eq(profiles.id, id))
      .run();
  });

  profileCrud.revalidate(id);
}

export async function deleteProfile(id: number) {
  // Clear profile assignments from hosts and delete the profile atomically.
  db.transaction((tx) => {
    tx.update(hosts)
      .set({ profileId: null })
      .where(eq(hosts.profileId, id))
      .run();

    tx.delete(profiles).where(eq(profiles.id, id)).run();
  });

  profileCrud.revalidate(id);
  revalidatePath('/hosts');
}

// ============================================================================
// Scripts
// ============================================================================

const scriptCrud = makeCrudActions<
  Pick<NewScript, 'path' | 'description' | 'content'>,
  Partial<Pick<NewScript, 'path' | 'description' | 'content'>>,
  number
>({
  table: scripts,
  idColumn: scripts.id,
  paths: () => ['/scripts', '/'],
});

export async function getScripts() {
  return db.select().from(scripts).orderBy(scripts.path);
}

export async function getScript(id: number) {
  return db.select().from(scripts).where(eq(scripts.id, id)).get();
}

export async function getScriptByPath(path: string) {
  return db.select().from(scripts).where(eq(scripts.path, path)).get();
}

export async function createScript(
  data: Pick<NewScript, 'path' | 'description' | 'content'>,
) {
  return scriptCrud.create(data);
}

export async function updateScript(
  id: number,
  data: Partial<Pick<NewScript, 'path' | 'description' | 'content'>>,
) {
  await scriptCrud.update(id, data);
}

export async function deleteScript(id: number) {
  await scriptCrud.remove(id);
}

// ============================================================================
// Settings
// ============================================================================

// Settings are a key/value upsert (no separate create/update, no
// timestamps), so they don't fit makeCrudActions' insert/update shape.
// `remove`/`revalidate` still apply cleanly, so we reuse those.
const settingCrud = makeCrudActions<
  Record<string, unknown>,
  Record<string, unknown>,
  string
>({
  table: settings,
  idColumn: settings.key,
  paths: () => ['/settings'],
  timestamps: false,
});

export async function getSettings() {
  const rows = await db.select().from(settings);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function getSetting(key: string) {
  const result = await db
    .select()
    .from(settings)
    .where(eq(settings.key, key))
    .get();
  return result?.value ?? null;
}

export async function setSetting(key: string, value: string) {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });

  settingCrud.revalidate();
  revalidatePath('/');
}

export async function deleteSetting(key: string) {
  await settingCrud.remove(key);
}
