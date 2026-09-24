/**
 * Runs the shipped zero-config arm over real trees with a recording `docker`,
 * and checks the shell reader agrees with `parseSpindriftFile`.
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
const VIEW_COUNTER = join(
  import.meta.dir,
  '../../../../apps/view-counter/spindrift.yaml',
);

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
  code: number;
  /** stdout followed by stderr. */
  output: string;
  dockerArgv: string[];
  /** Null when the step wrote no railpack config. */
  config: unknown;
};

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
    const output =
      (await new Response(proc.stdout).text()) +
      (await new Response(proc.stderr).text());

    const argv = await readFile(argvPath, 'utf8').catch(() => '');
    const configPath = join(workspace, 'railpack-plan', 'railpack-config.json');
    const config = await readFile(configPath, 'utf8')
      .then((text) => JSON.parse(text) as unknown)
      .catch(() => null);

    return {
      code,
      output,
      // A trailing newline from `printf '%s\n'`, not an empty argument.
      dockerArgv: argv === '' ? [] : argv.replace(/\n$/, '').split('\n'),
      config,
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

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
    // railpack joins the path under the app source, so it must be relative.
    expect(run.dockerArgv).toContain('--config-file');
    expect(run.dockerArgv.at(-1)).toBe('../out/railpack-config.json');
    // A string, since BuildKit argv-splits the `{cmd: …}` form and `a && b`
    // would pass `&&` to `a` as an argument.
    expect(configuredCommand(run)).toBe('go build -o out ./cmd');
    expect(configuredCommand(run)).toBe(parsed);
  });

  test('the demo App’s own declaration is the one that names its package', async () => {
    // The real file. Without its command, railpack compiles a package archive
    // and calls it a success.
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
    // `--config-file` fails when its file is absent.
    const run = await runArm({});
    expect(run.code).toBe(0);
    expect(run.dockerArgv).not.toContain('--config-file');
    expect(run.config).toBeNull();
  });

  test('a dockerfile declaration states no railpack command and is not read for one', async () => {
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
    // Core never advances an App's commit past an unparseable file, so this
    // is reachable only when something is already wrong.
    const run = await runArm({
      [`${SUBPATH}/spindrift.yaml`]:
        'build:\n  frontend: railpack\n   nope: [\n',
    });
    expect(run.code).not.toBe(0);
    expect(run.dockerArgv).toEqual([]);
  });

  test('quotes, newlines and command substitution survive as data', async () => {
    // This step runs on the runner, so nothing in the declaration may execute
    // here.
    const hostile = 'go build -o out ./cmd # "x" $(id) `id` $HOME';
    // A YAML double-quoted scalar, which is what JSON.stringify produces.
    const { run, parsed } = await declared(RAILPACK(JSON.stringify(hostile)));
    expect(run.code).toBe(0);
    expect(parsed).toBe(hostile);
    expect(configuredCommand(run)).toBe(hostile);
  });

  test('a multi-line command stays one command and forges no output line', async () => {
    // A newline reaching `$GITHUB_OUTPUT` could forge any `key=value` output.
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
    // railpack wraps a string command as `sh -c '<cmd>'` with no escaping.
    const { run } = await declared(RAILPACK("echo it's fine"));
    expect(run.code).not.toBe(0);
    // An `::error::` annotation, on stdout, which is where Actions reads them.
    expect(run.output).toContain(
      '::error::spindrift.yaml: build.command cannot contain a single quote',
    );
    expect(run.dockerArgv).toEqual([]);
  });
});
