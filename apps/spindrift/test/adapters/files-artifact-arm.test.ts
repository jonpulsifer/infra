/**
 * The hosted route's files arm, run as the file actually ships it.
 *
 * The other half of this agreement is `static/oci.ts`: the adapter pulls one
 * layer and reads it as a gzipped tar, which is only true of what this arm
 * pushes — `FROM scratch` + `COPY . /`, one layer, no build. A fixture cannot
 * prove the shipped script writes that Dockerfile; running the step's own
 * `run:` script can (the same reasoning as `build-report-statement.test.ts`).
 */
import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WORKFLOW = join(
  import.meta.dir,
  '../../../../.github/workflows/spindrift-build.yml',
);
const FRONTEND_STEP = 'Choose the frontend';

/** The `run:` script of the named step, straight out of the shipped file. */
async function frontendScript(): Promise<string> {
  const document = Bun.YAML.parse(await Bun.file(WORKFLOW).text()) as {
    jobs: { build: { steps: { name?: string; run?: string }[] } };
  };
  const step = document.jobs.build.steps.find((s) => s.name === FRONTEND_STEP);
  if (step?.run === undefined) {
    throw new Error(`${WORKFLOW} has no “${FRONTEND_STEP}” step with a script`);
  }
  return step.run;
}

async function runArm(input: {
  artifactType: string;
  scopeFiles: Readonly<Record<string, string>>;
}): Promise<{ outputs: Record<string, string>; workspace: string }> {
  const workspace = await mkdtemp(join(tmpdir(), 'spindrift-files-arm-'));
  const root = join(workspace, 'bundle');
  const scope = join(root, 'site');
  await mkdir(scope, { recursive: true });
  for (const [name, contents] of Object.entries(input.scopeFiles)) {
    await writeFile(join(scope, name), contents);
  }
  const outputPath = join(workspace, 'github-output');
  await writeFile(outputPath, '');

  const script = await frontendScript();
  const proc = Bun.spawn(['bash', '-c', script], {
    env: {
      ...process.env,
      ROOT: root,
      SUBPATH: 'site',
      FRONTEND: 'registry.example.test/zero-config:pinned',
      ARTIFACT_TYPE: input.artifactType,
      GITHUB_OUTPUT: outputPath,
      RUNNER_TEMP: workspace,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`the step exited ${code}: ${stderr}`);
  }

  const outputs: Record<string, string> = {};
  for (const line of (await readFile(outputPath, 'utf8')).split('\n')) {
    const equals = line.indexOf('=');
    if (equals > 0) {
      outputs[line.slice(0, equals)] = line.slice(equals + 1);
    }
  }
  return { outputs, workspace };
}

describe('the files arm of “Choose the frontend”', () => {
  test('a files artifact is the scope as one scratch COPY, never a build', async () => {
    const { outputs, workspace } = await runArm({
      artifactType: 'files',
      scopeFiles: {
        'index.html': '<!doctype html>',
        // A Dockerfile in the scope must not turn a files artifact into an
        // image build: the artifact type decides what the thing *is*; a
        // Dockerfile only ever decided how to build one.
        Dockerfile: 'FROM nginx',
      },
    });
    try {
      expect(outputs.context).toBe(join(workspace, 'bundle', 'site'));
      expect(outputs.file).toBe(
        join(workspace, 'files-artifact', 'Dockerfile'),
      );
      const dockerfile = await readFile(outputs.file as string, 'utf8');
      expect(dockerfile).toBe('FROM scratch\nCOPY . /\n');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('an image with a Dockerfile still builds from the bundle root', async () => {
    const { outputs, workspace } = await runArm({
      artifactType: 'image',
      scopeFiles: { Dockerfile: 'FROM scratch' },
    });
    try {
      expect(outputs.context).toBe(join(workspace, 'bundle'));
      expect(outputs.file).toBe(
        join(workspace, 'bundle', 'site', 'Dockerfile'),
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
