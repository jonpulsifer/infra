/**
 * The zero-config arm reading `spindrift.yaml`, run as the workflow ships it.
 *
 * §5's authority is only real if it reaches the builder, and the builder is
 * reached by a `docker run` inside a shell script — so the assertion has to be
 * about the argv that invocation receives and the file it points at, not about
 * a TypeScript function standing in for either. The step's own `run:` is
 * executed here against real trees with a recording `docker` on PATH (the same
 * reasoning as `dockerfile-context-arm.test.ts`, which cannot reach this arm
 * because it stops where docker starts).
 *
 * Two readers, one document: this shell reader and `parseSpindriftFile`. Every
 * case below asserts they agree, so the runner cannot come to honour a command
 * core never adopted, or drop one it did.
 */
import { describe, expect, test } from 'bun:test';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseSpindriftFile } from '../../src/domain/detection/spindrift-file.ts';

const WORKFLOW = join(
  import.meta.dir,
  '../../../../.github/workflows/spindrift-build.yml',
);
const FRONTEND_STEP = 'Choose the frontend';
const SUBPATH = 'apps/view-counter';
/** The demo's own declaration, so this test fails if that file stops fixing it. */
const VIEW_COUNTER = join(
  import.meta.dir,
  '../../../../apps/view-counter/spindrift.yaml',
);

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

type ArmRun = {
  /** Exit status of the shipped step. */
  code: number;
  stderr: string;
  /** Every argument the step handed `docker`, one per element. */
  dockerArgv: string[];
  /** The generated railpack config, or null when the step wrote none. */
  config: unknown;
};

/**
 * Run the shipped arm over one tree with a `docker` that records rather than
 * runs, and hand back what the builder would have been given.
 */
async function runArm(
  files: Readonly<Record<string, string>>,
): Promise<ArmRun> {
  const workspace = await mkdtemp(join(tmpdir(), 'spindrift-declaration-arm-'));
  try {
    const root = join(workspace, 'bundle');
    for (const [name, contents] of Object.entries(files)) {
      await mkdir(dirname(join(root, name)), { recursive: true });
      await writeFile(join(root, name), contents);
    }
    await mkdir(join(root, SUBPATH), { recursive: true });

    const argvPath = join(workspace, 'docker-argv');
    const shim = join(workspace, 'bin');
    await mkdir(shim, { recursive: true });
    await writeFile(
      join(shim, 'docker'),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${JSON.stringify(argvPath)}\n`,
    );
    await chmod(join(shim, 'docker'), 0o755);

    const outputPath = join(workspace, 'github-output');
    await writeFile(outputPath, '');

    const proc = Bun.spawn(['bash', '-c', await frontendScript()], {
      env: {
        ...process.env,
        PATH: `${shim}:${process.env.PATH ?? ''}`,
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
    const stderr = await new Response(proc.stderr).text();

    const argv = await readFile(argvPath, 'utf8').catch(() => '');
    const configPath = join(workspace, 'railpack-plan', 'railpack-config.json');
    const config = await readFile(configPath, 'utf8')
      .then((text) => JSON.parse(text) as unknown)
      .catch(() => null);

    return {
      code,
      stderr,
      // A trailing newline from `printf '%s\n'`, not an empty argument.
      dockerArgv: argv === '' ? [] : argv.replace(/\n$/, '').split('\n'),
      config,
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

/** What the shell reader made of a declaration, and what the parser did. */
async function declared(document: string): Promise<{
  run: ArmRun;
  parsed: string | null;
}> {
  const run = await runArm({ [`${SUBPATH}/spindrift.yaml`]: document });
  const proposal = parseSpindriftFile(document);
  return {
    run,
    parsed:
      proposal.build.frontend === 'railpack'
        ? proposal.build.buildCommand
        : null,
  };
}

/** The command the generated config would give railpack, or null for none. */
function configuredCommand(run: ArmRun): string | null {
  if (run.config === null) return null;
  const config = run.config as {
    steps?: { build?: { commands?: unknown[] } };
  };
  const commands = config.steps?.build?.commands ?? [];
  expect(commands).toHaveLength(1);
  return commands[0] as string;
}

const RAILPACK = (command: string) =>
  [
    'version: 1',
    'component:',
    '  kind: service',
    'build:',
    '  frontend: railpack',
    `  command: ${command}`,
    '  outputDirectory: null',
    'watchPaths:',
    `  - ${SUBPATH}`,
    '',
  ].join('\n');

describe('the zero-config arm of “Choose the frontend”', () => {
  test('a declared command reaches railpack as a config file, in string form', async () => {
    const { run, parsed } = await declared(RAILPACK('go build -o out ./cmd'));
    expect(run.code).toBe(0);
    // Relative on purpose: railpack joins the path under the app source, so
    // `/out/...` would resolve to `/scope/out/...` and not be found.
    expect(run.dockerArgv).toContain('--config-file');
    expect(run.dockerArgv.at(-1)).toBe('../out/railpack-config.json');
    // String, not `{cmd: …}`: BuildKit argv-splits the object form, so `a && b`
    // would reach the builder as a literal argument to `a`.
    expect(configuredCommand(run)).toBe('go build -o out ./cmd');
    expect(configuredCommand(run)).toBe(parsed);
  });

  test('the demo App’s own declaration is the one that names its package', async () => {
    // Not a fixture. If `apps/view-counter/spindrift.yaml` stops carrying the
    // command, the zero-config build goes back to compiling a package archive
    // and calling it a success — the defect this whole arm exists to refuse.
    const { run, parsed } = await declared(
      await readFile(VIEW_COUNTER, 'utf8'),
    );
    expect(run.code).toBe(0);
    expect(configuredCommand(run)).toBe('go build -o out ./cmd');
    expect(configuredCommand(run)).toBe(parsed);
  });

  test('`command: null` builds exactly as it did before the declaration existed', async () => {
    const { run, parsed } = await declared(RAILPACK('null'));
    expect(parsed).toBeNull();
    expect(run.code).toBe(0);
    expect(run.dockerArgv).not.toContain('--config-file');
    expect(run.config).toBeNull();
    expect(run.dockerArgv.at(-1)).toBe('/out/railpack-plan.json');
  });

  test('no `spindrift.yaml` at all builds exactly as it did before', async () => {
    // The path every App that has never been adopted takes. `--config-file`
    // hard-fails when its file is absent, so passing it here would turn every
    // one of those builds red.
    const run = await runArm({});
    expect(run.code).toBe(0);
    expect(run.dockerArgv).not.toContain('--config-file');
    expect(run.config).toBeNull();
  });

  test('a dockerfile declaration states no railpack command and is not read for one', async () => {
    // This scope reaches railpack only because it has no Dockerfile to build
    // — the arm above already took every scope that does. Reading `.command`
    // without checking the frontend would honour a field this document does
    // not have.
    const document = [
      'version: 1',
      'component:',
      '  kind: service',
      'build:',
      '  frontend: dockerfile',
      '  file: Dockerfile.release',
      'watchPaths:',
      `  - ${SUBPATH}`,
      '',
    ].join('\n');
    const { run, parsed } = await declared(document);
    expect(parsed).toBeNull();
    expect(run.code).toBe(0);
    expect(run.dockerArgv).not.toContain('--config-file');
  });

  test('a malformed declaration fails the build rather than guessing', async () => {
    // Core refuses to advance an App's authoritative commit past a file it
    // could not parse, so this should be unreachable — which is exactly why it
    // must be loud if it ever happens rather than silently building the shape
    // the operator wrote the file to correct.
    const run = await runArm({
      [`${SUBPATH}/spindrift.yaml`]:
        'build:\n  frontend: railpack\n   nope: [\n',
    });
    expect(run.code).not.toBe(0);
    expect(run.dockerArgv).toEqual([]);
  });

  test('quotes, newlines and command substitution survive as data', async () => {
    // `jq --arg` is what makes the operator's string a JSON value rather than
    // syntax. `$(…)` has to arrive at the builder unexpanded and unevaluated:
    // this step runs on the runner, and nothing the declaration says may run
    // here.
    const hostile = 'go build -o out ./cmd # "x" $(id) `id` $HOME';
    // A YAML double-quoted scalar, which is what JSON.stringify produces.
    const { run, parsed } = await declared(RAILPACK(JSON.stringify(hostile)));
    expect(run.code).toBe(0);
    expect(parsed).toBe(hostile);
    expect(configuredCommand(run)).toBe(hostile);
  });

  test('a multi-line command stays one command and forges no output line', async () => {
    // The workflow's own outputs are `key=value` lines in a file this step
    // appends to. A declaration that reached `$GITHUB_OUTPUT` could write any
    // of them; this one never goes near it.
    const document = [
      'version: 1',
      'component:',
      '  kind: service',
      'build:',
      '  frontend: railpack',
      '  command: |-',
      '    go build -o out ./cmd',
      '    context=/etc',
      '  outputDirectory: null',
      'watchPaths:',
      `  - ${SUBPATH}`,
      '',
    ].join('\n');
    const { run, parsed } = await declared(document);
    expect(run.code).toBe(0);
    expect(parsed).toBe('go build -o out ./cmd\ncontext=/etc');
    expect(configuredCommand(run)).toBe(parsed);
  });

  test('a single quote is refused rather than silently re-split', async () => {
    // railpack wraps a string command as `"sh -c '" + cmd + "'"` with no
    // escaping, so `echo it's fine` becomes a command that runs something
    // else. Red build, named reason.
    const { run } = await declared(RAILPACK("echo it's fine"));
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('single quote');
    expect(run.dockerArgv).toEqual([]);
  });
});
