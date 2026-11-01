#!/usr/bin/env bun
/**
 * Moves each site's serving release from the old depot into the sites bucket:
 * the release's files under `<name>/`, and a marker owned by the site's
 * tailnet login, else the owner the JSON file names, else `--default-owner`.
 * A site already in the bucket is left alone, so a second run finishes what a
 * first one did not. Prints the plan; `--apply` writes it.
 *
 *   DATABASE_URL=… bun apps/kthx/scripts/move-sites.ts [owners.json]
 *     [--default-owner <email>] [--bucket <sites bucket>] [--apply]
 *
 * It reads and writes with the operator's Application Default Credentials.
 */
import { parseArgs } from 'node:util';
import { type BundleFile, readBundle } from '@repo/archive/bundle';
import { parseGcsLocation, readGcsBytes } from '@repo/archive/gcs';
import { SQL } from 'bun';
import { loadCredentials } from '../cli/adc.ts';
import {
  type Bucket,
  claimMarker,
  readMarker,
  type SiteFile,
  syncSite,
} from '../server/bucket.ts';

/** The old upload ceilings: compressed, and unpacked. */
const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 32 * 1024 * 1024;

export interface Serving {
  readonly name: string;
  readonly owner_login: string | null;
  /** `gs://<depot>/releases/<digest>.tar.gz` */
  readonly location: string;
}

export interface Planned {
  readonly name: string;
  readonly location: string;
  readonly owner: string | null;
  readonly from: 'login' | 'file' | 'default' | null;
}

/** Each site's owner, by the order the move promises. */
export function plan(
  rows: readonly Serving[],
  owners: Readonly<Record<string, string>>,
  fallback: string | null,
): Planned[] {
  return rows.map((row) => {
    const login = row.owner_login?.trim().toLowerCase() || null;
    const named = owners[row.name]?.trim().toLowerCase() || null;
    const owner = login ?? named ?? fallback;
    const from =
      login !== null
        ? 'login'
        : named !== null
          ? 'file'
          : fallback !== null
            ? 'default'
            : null;
    return { name: row.name, location: row.location, owner, from };
  });
}

/** A lone top-level directory is the site, as a release was served. */
export function filesOf(bundle: readonly BundleFile[]): SiteFile[] {
  const paths = bundle.map((file) => file.path.replace(/^\/+/, ''));
  const tops = new Set(paths.map((path) => path.split('/')[0]));
  const [top] = tops;
  const wrapped =
    tops.size === 1 &&
    top !== undefined &&
    paths.every((path) => path.includes('/'));
  return bundle.map((file, index) => ({
    path: wrapped
      ? (paths[index] ?? '').slice((top ?? '').length + 1)
      : (paths[index] ?? ''),
    bytes: file.bytes,
  }));
}

export type Outcome = 'moved' | 'present' | 'missing' | 'taken';

/** One site: its release's files, then its marker, unless it is already there. */
export async function moveSite(
  depot: Bucket['auth'],
  sites: Bucket,
  site: Planned & { owner: string },
): Promise<Outcome> {
  if ((await readMarker(sites, site.name)) !== null) return 'present';
  const object = parseGcsLocation(site.location);
  if (object === null) return 'missing';
  const archive = await readGcsBytes({
    bucketName: object.bucket,
    objectName: object.object,
    auth: depot,
    maxBytes: MAX_ARCHIVE_BYTES,
  });
  if (archive === null) return 'missing';
  const files = filesOf(
    readBundle(archive as Uint8Array<ArrayBuffer>, MAX_UNPACKED_BYTES),
  );
  const marker = await claimMarker(sites, site.name, site.owner);
  if (marker === null) return 'taken';
  await syncSite(sites, site.name, files, site.owner, marker.generation);
  return 'moved';
}

async function servingRows(sql: SQL): Promise<Serving[]> {
  // Before the bucket migration a deleted site keeps its row; after it, it has
  // none.
  const [tombstones] = (await sql`
    select exists (
      select 1 from information_schema.columns
      where table_name = 'sites' and column_name = 'deleted_at'
        and table_schema = any(current_schemas(false))
    ) as present
  `) as { present: boolean }[];
  return (await sql.unsafe(`
    select s.name, s.owner_login, r.location
    from sites s
    join releases r on r.site = s.name and r.n = s.serving
    ${tombstones?.present ? 'where s.deleted_at is null' : ''}
    order by s.name
  `)) as Serving[];
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      apply: { type: 'boolean' },
      'default-owner': { type: 'string' },
      bucket: { type: 'string' },
    },
    allowPositionals: true,
  });
  const url = Bun.env.DATABASE_URL?.trim();
  if (!url) throw new Error('DATABASE_URL names the kthx control database');
  const [ownersFile] = positionals;
  const owners: Record<string, string> =
    ownersFile === undefined ? {} : await Bun.file(ownersFile).json();
  const fallback = values['default-owner']?.trim().toLowerCase() || null;

  const sql = new SQL(url, { max: 1 });
  const planned = plan(await servingRows(sql), owners, fallback);
  await sql.close();

  const creds = loadCredentials();
  const auth = { token: () => creds.accessToken() };
  const sites: Bucket = {
    bucketName: values.bucket ?? 'bluenose-kthx-sites',
    auth,
  };

  let failed = 0;
  for (const site of planned) {
    if (site.owner === null) {
      console.log(
        `${site.name}  skipped: no owner; name one in the file or --default-owner`,
      );
      failed += 1;
      continue;
    }
    const line = `${site.name}  owner ${site.owner} (${site.from})  from ${site.location}`;
    if (values.apply !== true) {
      console.log(`${line}  would move`);
      continue;
    }
    try {
      console.log(
        `${line}  ${await moveSite(auth, sites, { ...site, owner: site.owner })}`,
      );
    } catch (cause) {
      failed += 1;
      console.log(`${line}  failed: ${(cause as Error).message}`);
    }
  }
  console.log(
    `${planned.length} sites${values.apply === true ? '' : ', dry run: pass --apply to write'}${failed > 0 ? `, ${failed} not moved` : ''}`,
  );
  if (failed > 0) process.exitCode = 1;
}

if (import.meta.main) await main();
