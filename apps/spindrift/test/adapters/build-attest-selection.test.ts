/**
 * Runs the hosted route's attest step as the workflow file ships it, since a
 * faked runner passes a workflow that signs the wrong digests.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  ATTACHMENT_DIGEST,
  attested,
  GCLOUD_STUB,
  INDEX_DIGEST,
  indexStub,
  RUNTIME_DIGEST,
} from '../harness/attest-step.ts';

const WORKFLOW = join(
  import.meta.dir,
  '../../../../.github/workflows/spindrift-build.yml',
);
const ATTEST_STEP = 'Attest the artifact';

const SIGNER =
  'gcpkms://projects/trusted-builds/locations/northamerica-northeast1/keyRings/keys/cryptoKeys/signer';
const ATTESTOR = 'projects/trusted-builds/attestors/provenance';
const DESTINATION =
  'northamerica-northeast1-docker.pkg.dev/trusted-builds/i/demo/web';

async function attestScript(): Promise<string> {
  const document = Bun.YAML.parse(await Bun.file(WORKFLOW).text()) as {
    jobs: { build: { steps: { name?: string; run?: string }[] } };
  };
  const step = document.jobs.build.steps.find((s) => s.name === ATTEST_STEP);
  if (step?.run === undefined) {
    throw new Error(`${WORKFLOW} has no “${ATTEST_STEP}” step with a script`);
  }
  return step.run;
}

describe('the hosted route attests what a runtime can run', () => {
  test('the index and the platform manifest, and not the attachment', async () => {
    const digests = await attested(
      await attestScript(),
      { gcloud: GCLOUD_STUB, docker: indexStub() },
      {
        ATTESTOR,
        SIGNER,
        DESTINATIONS: DESTINATION,
        DIGEST: INDEX_DIGEST,
        CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
      },
    );

    // A Deploy pins the index, and admission is asked about the platform
    // manifest a runtime resolves it to.
    expect(digests).toEqual([
      `${DESTINATION}@${INDEX_DIGEST}`,
      `${DESTINATION}@${RUNTIME_DIGEST}`,
    ]);
    expect(digests).not.toContain(`${DESTINATION}@${ATTACHMENT_DIGEST}`);
  });

  test('an occurrence that already exists is done, not a failure', async () => {
    // A rerun or an identical rebuild meets the occurrence an earlier green
    // attest created.
    const conflictStub = `case "$*" in
  *print-access-token*) echo stub-token ;;
  *sign-and-create*) echo 'ERROR: (gcloud.beta.container.binauthz.attestations.sign-and-create) Resource in projects [trusted-builds] is the subject of a conflict: Could not create occurrence' >&2; exit 1 ;;
esac
exit 0`;

    const digests = await attested(
      await attestScript(),
      { gcloud: conflictStub, docker: indexStub() },
      {
        ATTESTOR,
        SIGNER,
        DESTINATIONS: DESTINATION,
        DIGEST: INDEX_DIGEST,
        CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
      },
    );

    expect(digests).toEqual([
      `${DESTINATION}@${INDEX_DIGEST}`,
      `${DESTINATION}@${RUNTIME_DIGEST}`,
    ]);
  });

  test('any other signing failure still fails the build', async () => {
    const brokenStub = `case "$*" in
  *print-access-token*) echo stub-token ;;
  *sign-and-create*) echo 'ERROR: PERMISSION_DENIED: no signing for you' >&2; exit 1 ;;
esac
exit 0`;

    await expect(
      attested(
        await attestScript(),
        { gcloud: brokenStub, docker: indexStub() },
        {
          ATTESTOR,
          SIGNER,
          DESTINATIONS: DESTINATION,
          DIGEST: INDEX_DIGEST,
          CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
        },
      ),
    ).rejects.toThrow('the attest step failed');
  });
});
