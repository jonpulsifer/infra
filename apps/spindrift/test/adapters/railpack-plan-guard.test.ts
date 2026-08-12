/**
 * The zero-config arm's start-command guard, run as the workflow ships it.
 *
 * The failure it exists for was not a build error. railpack's Go provider emits
 * `go build -o out` with no package argument, so a module whose root package is
 * a library compiled to a 0644 *package archive* named `out` and exited 0 —
 * green build, real push, signed, attested, and a container that could only say
 * `./out: Permission denied`. A fixture cannot prove the shipped step turns
 * that into a red build; running the step's own `run:` script over a plan
 * railpack actually generates can (the same reasoning as
 * `dockerfile-context-arm.test.ts`).
 *
 * The last case closes the loop: the command the step appends is executed
 * against the artifact shape that shipped, and has to reject it.
 */
import { describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WORKFLOW = join(
  import.meta.dir,
  '../../../../.github/workflows/spindrift-build.yml',
);
const GUARD_STEP = 'Make the plan check its own start command';
const FRONTEND_STEP = 'Choose the frontend';

type WorkflowStep = {
  name?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
};

/** The named step, straight out of the shipped file. */
async function step(name: string): Promise<WorkflowStep> {
  const document = Bun.YAML.parse(await Bun.file(WORKFLOW).text()) as {
    jobs: { build: { steps: WorkflowStep[] } };
  };
  const found = document.jobs.build.steps.find((s) => s.name === name);
  if (found === undefined) throw new Error(`${WORKFLOW} has no “${name}” step`);
  return found;
}

type Plan = {
  deploy: { startCommand?: string };
  steps: { name: string; commands?: { cmd: string }[] }[];
};

/** The `run:` script of the guard step, straight out of the shipped file. */
async function guardScript(): Promise<string> {
  const run = (await step(GUARD_STEP)).run;
  if (run === undefined) {
    throw new Error(`${WORKFLOW} has no “${GUARD_STEP}” step with a script`);
  }
  return run;
}

/** Run the shipped guard over one plan and hand back what it wrote. */
async function guard(plan: Plan): Promise<Plan> {
  const workspace = await mkdtemp(join(tmpdir(), 'spindrift-plan-guard-'));
  try {
    const planPath = join(workspace, 'railpack-plan.json');
    await writeFile(planPath, JSON.stringify(plan));
    const proc = Bun.spawn(['bash', '-c', await guardScript()], {
      env: { ...process.env, PLAN: planPath },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(
        `the step exited ${code}: ${await new Response(proc.stderr).text()}`,
      );
    }
    return JSON.parse(await readFile(planPath, 'utf8')) as Plan;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

/** The commands of a plan's build step, as bare strings. */
function buildCommands(plan: Plan): string[] {
  const build = plan.steps.find((s) => s.name === 'build');
  return (build?.commands ?? []).map((c) => c.cmd);
}

/**
 * The plan `railpack prepare` v0.35.0 generates for `apps/view-counter`,
 * verbatim in the parts this step reads — a library at the module root, so
 * `go build` names no package and the start command is a bare `./out`.
 */
function viewCounterPlan(): Plan {
  return {
    deploy: { startCommand: './out' },
    steps: [
      { name: 'install', commands: [{ cmd: 'go mod download' }] },
      {
        name: 'build',
        commands: [{ cmd: 'go build -ldflags="-w -s" -o out' }],
      },
    ],
  };
}

describe('“Make the plan check its own start command”', () => {
  test('a bare relative start command has to be executable when the build ends', async () => {
    expect(buildCommands(await guard(viewCounterPlan()))).toEqual([
      'go build -ldflags="-w -s" -o out',
      'test -x ./out',
    ]);
  });

  test('the check is appended, so it runs after the command that produces the file', async () => {
    const commands = buildCommands(await guard(viewCounterPlan()));
    expect(commands.at(-1)).toBe('test -x ./out');
  });

  test('a start command carrying arguments names no file and is left alone', async () => {
    // `node server.js` is not a path to test, and an interpreter that cannot
    // find its script fails loudly at exec. Only the compiled shape is silent.
    const plan = viewCounterPlan();
    plan.deploy.startCommand = 'node server.js';
    expect(buildCommands(await guard(plan))).toEqual([
      'go build -ldflags="-w -s" -o out',
    ]);
  });

  test('a plan with no start command is left alone', async () => {
    const plan = viewCounterPlan();
    plan.deploy.startCommand = undefined;
    expect(buildCommands(await guard(plan))).toEqual([
      'go build -ldflags="-w -s" -o out',
    ]);
  });

  test('a plan with no build step survives the step intact', async () => {
    // Not every provider emits one, and the guard is not a reason to fail a
    // build it has nothing to say about.
    const plan = viewCounterPlan();
    plan.steps = plan.steps.filter((s) => s.name !== 'build');
    expect((await guard(plan)).steps.map((s) => s.name)).toEqual(['install']);
  });

  test('the guard runs on the arm that writes the plan it reads', async () => {
    // A guard wired to an output nothing sets does not fail — it silently
    // never runs, which is the same invisibility this whole step exists to
    // remove. Only the zero-config arm writes `plan`; the other two hand the
    // build a Dockerfile, which this step cannot read as JSON.
    const guard = await step(GUARD_STEP);
    expect(guard.if).toBe("steps.frontend.outputs.plan != ''");
    expect(guard.env?.PLAN).toContain('steps.frontend.outputs.plan');
    expect((await step(FRONTEND_STEP)).run).toContain("printf 'plan=%s\\n'");
  });

  test('the appended check rejects the package archive that shipped', async () => {
    // The artifact Build 25 pushed: `go build -o` against a non-main package
    // writes an ar archive at mode 0644. Executable to nobody, root included —
    // Linux grants exec only when at least one execute bit is set.
    const workspace = await mkdtemp(join(tmpdir(), 'spindrift-plan-guard-'));
    try {
      await writeFile(join(workspace, 'out'), '!<arch>\n__.PKGDEF', {
        mode: 0o644,
      });
      const check = buildCommands(await guard(viewCounterPlan())).at(-1);
      if (check === undefined) {
        throw new Error('the step appended no check to run');
      }
      const rejected = Bun.spawn(['sh', '-c', check], { cwd: workspace });
      expect(await rejected.exited).not.toBe(0);

      // And accepts a real binary put where the start command points.
      await writeFile(join(workspace, 'out'), '#!/bin/sh\nexit 0\n');
      await chmod(join(workspace, 'out'), 0o755);
      const accepted = Bun.spawn(['sh', '-c', check], { cwd: workspace });
      expect(await accepted.exited).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
