/**
 * Runs a route's attest step with outbound commands stubbed and returns what it
 * would have signed. Cloud Run admits the platform manifest an index resolves
 * to, so the step signs children too, but never BuildKit's attestation manifest.
 */
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A real single-platform build: `provenance` and `sbom` still make it an index,
 * and its second entry is the attestation manifest.
 */
export const SINGLE_PLATFORM_INDEX = {
  schemaVersion: 2,
  mediaType: 'application/vnd.oci.image.index.v1+json',
  manifests: [
    {
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      digest:
        'sha256:25790e965850eb3e5cae462b96cbd8eeea9c204a3852bcc6d47ba526845066ee',
      size: 3921,
      platform: { architecture: 'amd64', os: 'linux' },
    },
    {
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      digest:
        'sha256:9cfb02d0b233985e598e92a066549cb5738083e1bef29bd15c9e6961f93ec731',
      size: 839,
      annotations: {
        'vnd.docker.reference.digest':
          'sha256:25790e965850eb3e5cae462b96cbd8eeea9c204a3852bcc6d47ba526845066ee',
        'vnd.docker.reference.type': 'attestation-manifest',
      },
      platform: { architecture: 'unknown', os: 'unknown' },
    },
  ],
};

/** The index digest the builder reports, which a Deploy pins. */
export const INDEX_DIGEST =
  'sha256:426ae4acd70b00275a15f9ea9191666ac15d472fb369f57f9f4b89de7c3305ac';
/** The manifest a runtime resolves the index to, which admission checks. */
export const RUNTIME_DIGEST = SINGLE_PLATFORM_INDEX.manifests[0]?.digest ?? '';
/** BuildKit's attestation manifest, which no runtime resolves to. */
export const ATTACHMENT_DIGEST =
  SINGLE_PLATFORM_INDEX.manifests[1]?.digest ?? '';

export const GCLOUD_STUB = `case "$*" in
  *print-access-token*) echo stub-token ;;
esac
exit 0`;

/** Prints the index for any arguments; `printf`, as a test may stub `cat`. */
export function indexStub(): string {
  return `printf '%s\\n' '${JSON.stringify(SINGLE_PLATFORM_INDEX)}'`;
}

/**
 * Runs `script` under `bash`, which `set -euo pipefail` needs, with `stubs` first
 * on `PATH`, and returns the `destination@digest` from each `attesting` line.
 */
export async function attested(
  script: string,
  stubs: Record<string, string>,
  env: Record<string, string> = {},
): Promise<string[]> {
  const directory = await mkdtemp(join(tmpdir(), 'spindrift-attest-'));
  try {
    const bin = join(directory, 'bin');
    for (const [name, body] of Object.entries(stubs)) {
      const path = join(bin, name);
      await Bun.write(path, `#!/usr/bin/env bash\n${body}\n`);
      await chmod(path, 0o755);
    }
    const path = join(directory, 'step.sh');
    // The build service expands the route's `$$` escape back to `$`.
    await writeFile(path, script.replaceAll('$$', '$'));

    const child = Bun.spawn(['bash', path], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { PATH: `${bin}:${Bun.env.PATH ?? ''}`, ...env },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`the attest step failed:\n${stdout}\n${stderr}`);
    }

    return [...stdout.matchAll(/^attesting (\S+)$/gm)].map(
      (match) => match[1] ?? '',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
