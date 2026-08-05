/**
 * Running a route's attest step for real, to see what it would have signed.
 *
 * Both build routes attest the index and then the children the registry names
 * under it, because an index is not what a runtime runs — Cloud Run resolves it
 * to its own platform's manifest *before* admission, and a digest nothing
 * attested reads as `denied by attestor` on an artifact that was attested one
 * indirection up.
 *
 * What a child is, though, is the thing worth testing: BuildKit's `provenance`
 * and `sbom` hang manifests off that same index, nothing ever resolves to one,
 * and each one signed is a KMS operation and an occurrence per destination per
 * build spent on a digest no admission decision is made about.
 *
 * Asserting on the *text* of a selection would pass for any expression that
 * merely mentions `attestation-manifest`. So the step is run instead: what
 * leaves the box is stubbed, and the digests the step named are the digests it
 * would have signed.
 */
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A registry's answer for a real single-platform build, captured 2026-08-04
 * from `ghcr.io/jonpulsifer/spindrift@sha256:426ae4ac…`.
 *
 * One platform was asked for and two manifests came back. That is the whole
 * problem in one document: `provenance` and `sbom` make the push an index even
 * at one platform, and the second entry is the attestation manifest they hang
 * off it — `unknown/unknown`, annotated `attestation-manifest`, and not
 * something any runtime can run.
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

/** The index the builder reported — what a Deploy pins. */
export const INDEX_DIGEST =
  'sha256:426ae4acd70b00275a15f9ea9191666ac15d472fb369f57f9f4b89de7c3305ac';
/** The manifest a runtime resolves that index to — what admission asks about. */
export const RUNTIME_DIGEST = SINGLE_PLATFORM_INDEX.manifests[0]?.digest ?? '';
/** BuildKit's own attachment — what no runtime ever asks about. */
export const ATTACHMENT_DIGEST =
  SINGLE_PLATFORM_INDEX.manifests[1]?.digest ?? '';

/** Enough `gcloud` for a step that lists a key version and then signs. */
export const GCLOUD_STUB = `case "$*" in
  *print-access-token*) echo stub-token ;;
esac
exit 0`;

/**
 * A command that answers with the index and ignores how it was asked.
 *
 * `printf` rather than a `cat` heredoc, because a stub directory is on `PATH`
 * ahead of everything and a step that stubs `cat` would otherwise be stubbing
 * this too.
 */
export function indexStub(): string {
  return `printf '%s\\n' '${JSON.stringify(SINGLE_PLATFORM_INDEX)}'`;
}

/**
 * Run `script` with `stubs` shadowing the commands that would leave the box,
 * and return the `destination@digest` references its own `attesting …` lines
 * named, in order.
 *
 * `bash`, not `sh`: both steps open with `set -euo pipefail`, which a POSIX
 * shell refuses outright — running them under the wrong shell tests a script
 * neither route executes.
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
    // What the build service does to a step before the container sees it:
    // template expansion turns its `$$` literal-dollar escape back into `$`.
    // The route escapes every dollar on the way in, so running the submitted
    // text verbatim would hand bash a program that is not shell.
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
