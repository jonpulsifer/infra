/**
 * Loading and validating the installation manifest.
 *
 * The manifest is read once at boot from a mounted file (the chart renders it
 * from values into a ConfigMap) or, for tests and local runs, from an inline
 * document in the environment. Validation failures are fatal and name every
 * offending key at once — a half-configured installation must not reach the
 * point where it can place a workload.
 */
import {
  type InstallationManifest,
  installationManifestSchema,
} from './manifest.schema.ts';

/** Path to a YAML or JSON manifest document. */
export const MANIFEST_PATH_VAR = 'SPINDRIFT_MANIFEST_PATH';
/** An inline YAML or JSON manifest document, used in place of a file. */
export const MANIFEST_INLINE_VAR = 'SPINDRIFT_MANIFEST';

/** Raised when the manifest is absent, unparseable, or invalid. */
export class ManifestError extends Error {
  override readonly name = 'ManifestError';
}

type Env = Record<string, string | undefined>;

/**
 * Parse and validate a manifest document. Accepts YAML, and therefore JSON.
 *
 * @param document the raw manifest text
 * @param source where it came from, for error messages
 */
export function parseManifest(
  document: string,
  source: string,
): InstallationManifest {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(document);
  } catch (cause) {
    throw new ManifestError(
      `${source}: not valid YAML: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const result = installationManifestSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => {
        const path = issue.path.join('.');
        return `  ${path === '' ? '(root)' : path}: ${issue.message}`;
      })
      .join('\n');
    throw new ManifestError(
      `${source}: invalid installation manifest\n${issues}`,
    );
  }
  return result.data;
}

/**
 * Read the manifest the environment points at.
 *
 * `SPINDRIFT_MANIFEST_PATH` wins over `SPINDRIFT_MANIFEST`; neither being set is
 * an error, because there is no manifest this code could invent.
 */
export async function loadManifest(
  env: Env = Bun.env,
): Promise<InstallationManifest> {
  const path = env[MANIFEST_PATH_VAR]?.trim();
  if (path) {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      throw new ManifestError(`${MANIFEST_PATH_VAR}=${path}: no such file`);
    }
    return parseManifest(await file.text(), path);
  }

  const inline = env[MANIFEST_INLINE_VAR];
  if (inline?.trim()) {
    return parseManifest(inline, `$${MANIFEST_INLINE_VAR}`);
  }

  throw new ManifestError(
    `no installation manifest: set ${MANIFEST_PATH_VAR} to a manifest file or ${MANIFEST_INLINE_VAR} to its contents`,
  );
}

export type { InstallationManifest } from './manifest.schema.ts';
