/**
 * The server's view of the sites bucket: markers, cached for a few seconds so
 * every API call on a site costs no bucket read, and which names already have
 * a control row and a database.
 */
import { listGcsObjects } from '@repo/archive/gcs';
import {
  type Bucket,
  claimMarker,
  listMarkers,
  MARKER,
  type Marker,
  readMarker,
  removeSite,
  type SiteFile,
  type Synced,
  syncSite,
} from './bucket.ts';

/** How long a marker, or its absence, is believed. */
export const MARKER_TTL_MS = 5_000;

interface Held<T> {
  readonly value: Promise<T>;
  readonly at: number;
}

export class Sites {
  readonly #markers = new Map<string, Held<Marker | null>>();
  #all: Held<Marker[]> | null = null;
  /** Names with a control row. */
  readonly rows = new Set<string>();
  /** Names whose database is provisioned. */
  readonly databases = new Set<string>();

  constructor(
    readonly bucket: Bucket,
    private readonly ttlMs = MARKER_TTL_MS,
  ) {}

  /** `fresh` skips the cache, for a decision that must not be stale. */
  marker(name: string, fresh = false): Promise<Marker | null> {
    const held = this.#markers.get(name);
    if (!fresh && held !== undefined && Date.now() - held.at < this.ttlMs) {
      return held.value;
    }
    const value = readMarker(this.bucket, name);
    this.#markers.set(name, { value, at: Date.now() });
    // A failed read is not cached: the next request asks again.
    value.catch(() => this.#markers.delete(name));
    if (this.#markers.size > 10_000) this.#markers.clear();
    return value;
  }

  all(fresh = false): Promise<Marker[]> {
    const held = this.#all;
    if (!fresh && held !== null && Date.now() - held.at < this.ttlMs) {
      return held.value;
    }
    const value = listMarkers(this.bucket);
    const entry = { value, at: Date.now() };
    this.#all = entry;
    value.catch(() => {
      if (this.#all === entry) this.#all = null;
    });
    return value;
  }

  forget(name: string): void {
    this.#markers.delete(name);
    this.#all = null;
  }

  /** Drops what this process knows of a deleted site. */
  dropped(name: string): void {
    this.forget(name);
    this.rows.delete(name);
    this.databases.delete(name);
  }

  async claim(name: string, owner: string): Promise<Marker | null> {
    try {
      return await claimMarker(this.bucket, name, owner);
    } finally {
      this.forget(name);
    }
  }

  async publish(
    name: string,
    files: readonly SiteFile[],
    owner: string,
    generation: string,
  ): Promise<Synced> {
    try {
      return await syncSite(this.bucket, name, files, owner, generation);
    } finally {
      this.forget(name);
    }
  }

  /** The site's object paths, without its marker, in name order. */
  async paths(name: string): Promise<string[]> {
    const prefix = `${name}/`;
    const objects = await listGcsObjects({
      bucketName: this.bucket.bucketName,
      auth: this.bucket.auth,
      prefix,
    });
    return objects
      .map((object) => object.name.slice(prefix.length))
      .filter((path) => path !== MARKER);
  }

  async remove(name: string): Promise<number> {
    try {
      return await removeSite(this.bucket, name);
    } finally {
      this.forget(name);
    }
  }
}
