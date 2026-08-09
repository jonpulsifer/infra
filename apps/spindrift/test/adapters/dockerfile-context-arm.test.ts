/**
 * The Dockerfile arm's context probe, run as the workflow actually ships it.
 *
 * One rule, three readers: the hosted workflow's "Choose the frontend" step,
 * the BuildKit program the other routes run (`DOCKERFILE_CONTEXT_PROBE`), and
 * detection's inspect-time mirror (`dockerfileBuildContext`). A fixture cannot
 * prove the shipped script chooses the context the operator was told about;
 * running the step's own `run:` script over the same tree detection reads can
 * (the same reasoning as `files-artifact-arm.test.ts`) — so each case below
 * asserts the arm's answer *and* that detection's answer is the same one.
 */
import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DOCKERFILE_CONTEXT_PROBE } from '../../src/adapters/build/buildkit.ts';
import { dockerfileBuildContext } from '../../src/domain/detection/dockerfile-context.ts';
import { diskTree } from '../../src/domain/detection/tree.ts';

const WORKFLOW = join(
  import.meta.dir,
  '../../../../.github/workflows/spindrift-build.yml',
);
const FRONTEND_STEP = 'Choose the frontend';
const SUBPATH = 'apps/ddns';

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

async function runArm(
  files: Readonly<Record<string, string>>,
): Promise<{ outputs: Record<string, string>; workspace: string }> {
  const workspace = await mkdtemp(join(tmpdir(), 'spindrift-context-arm-'));
  const root = join(workspace, 'bundle');
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), contents);
  }
  const outputPath = join(workspace, 'github-output');
  await writeFile(outputPath, '');

  const script = await frontendScript();
  const proc = Bun.spawn(['bash', '-c', script], {
    env: {
      ...process.env,
      ROOT: root,
      SUBPATH,
      FRONTEND: 'registry.example.test/zero-config:pinned',
      ARTIFACT_TYPE: 'image',
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

/** Run the shipped arm and detection's mirror over one tree; both must agree. */
async function contextChosen(
  files: Readonly<Record<string, string>>,
): Promise<'root' | 'scope'> {
  const { outputs, workspace } = await runArm(files);
  try {
    const root = join(workspace, 'bundle');
    const decided = await dockerfileBuildContext(diskTree(root), SUBPATH);
    const armChose =
      outputs.context === join(root, SUBPATH)
        ? ('scope' as const)
        : ('root' as const);
    if (armChose === 'root') expect(outputs.context).toBe(root);
    expect(outputs.file).toBe(join(root, SUBPATH, 'Dockerfile'));
    expect(decided.context).toBe(armChose);
    return armChose;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

describe('the Dockerfile arm of “Choose the frontend”', () => {
  test('a subpath Dockerfile copying from beside itself builds with its directory as the context', async () => {
    // The failing arrangement: subpath scope, directory-context Dockerfile —
    // `COPY go.mod ./` with go.mod beside the Dockerfile and not at the
    // bundle root, the convention every standalone repository ships. The
    // root as context died 5.4s into buildx with `"/go.mod": not found`.
    expect(
      await contextChosen({
        [`${SUBPATH}/Dockerfile`]:
          'FROM golang:1.24\nCOPY go.mod ./\nCOPY . .\n',
        [`${SUBPATH}/go.mod`]: 'module example.test/ddns\n',
      }),
    ).toBe('scope');
  });

  test('a monorepo Dockerfile keeps the bundle root as the context', async () => {
    expect(
      await contextChosen({
        'package.json': '{"name":"monorepo"}\n',
        [`${SUBPATH}/Dockerfile`]:
          'FROM oven/bun:1\nCOPY package.json ./\nCOPY . .\n',
      }),
    ).toBe('root');
  });

  test('a source resolving at both roots is not evidence, so the root convention holds', async () => {
    expect(
      await contextChosen({
        'go.mod': 'module example.test/monorepo\n',
        [`${SUBPATH}/Dockerfile`]: 'FROM golang:1.24\nCOPY go.mod ./\n',
        [`${SUBPATH}/go.mod`]: 'module example.test/ddns\n',
      }),
    ).toBe('root');
  });

  test('`COPY ./` names the whole context and decides nothing', async () => {
    // `./` normalizes to an empty source, which resolves to a directory both
    // roots have — never evidence. The shell probes always read it that way;
    // the mirror once turned it into `{context: 'scope', copies: ''}` and a
    // sentence claiming a context the build does not use.
    expect(
      await contextChosen({
        [`${SUBPATH}/Dockerfile`]: 'FROM golang:1.24\nCOPY ./ /app\n',
        [`${SUBPATH}/go.mod`]: 'module example.test/ddns\n',
      }),
    ).toBe('root');
  });

  test('stage copies, globs and absolute paths decide nothing', async () => {
    expect(
      await contextChosen({
        [`${SUBPATH}/Dockerfile`]:
          'FROM golang:1.24 AS build\n' +
          'COPY --from=build /app /app\n' +
          'COPY go.* ./\n' +
          'ADD https://example.test/tool /tool\n' +
          'COPY . .\n',
        [`${SUBPATH}/go.mod`]: 'module example.test/ddns\n',
      }),
    ).toBe('root');
  });

  test('the workflow carries the same probe the BuildKit program routes run', async () => {
    // Verbatim: the function is defined once (`buildkit.ts`) and shipped
    // twice, and the two copies drifting apart would let the hosted route
    // answer differently from the others over the same Dockerfile.
    expect(await frontendScript()).toContain(DOCKERFILE_CONTEXT_PROBE);
  });
});
