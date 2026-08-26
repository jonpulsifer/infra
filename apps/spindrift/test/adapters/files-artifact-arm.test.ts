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
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
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
  /** What the scope's `spindrift.yaml` named, as core resolved it (§3). */
  outputDirectory?: string;
  /** The framework a `vercel-output` build declares to the platform (§6). */
  vercelFramework?: string;
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
      OUTPUT_DIRECTORY: input.outputDirectory ?? '',
      VERCEL_FRAMEWORK: input.vercelFramework ?? '',
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

  test('a declared output directory builds the scope first and lifts from it', async () => {
    const { outputs, workspace } = await runArm({
      artifactType: 'files',
      // A scope that declares an output directory is the *sources* of a site,
      // so its own Dockerfile is how the site gets made — the arm must fall
      // through to the ladder rather than shipping the tree as it stands.
      scopeFiles: { Dockerfile: 'FROM node', 'package.json': '{}' },
      outputDirectory: 'dist',
    });
    try {
      expect(outputs.lift).toBe('dist');
      // The ladder's answer, not the files short-circuit: this is the build
      // that produces the site, and `Lift the site out of the build` runs it.
      expect(outputs.context).toBe(join(workspace, 'bundle'));
      expect(outputs.file).toBe(
        join(workspace, 'bundle', 'site', 'Dockerfile'),
      );
      // Written either way, because both paths end by exporting one directory
      // as the single gzipped tar layer `static/oci.ts` reads back.
      const scratch = await readFile(outputs.scratchfile as string, 'utf8');
      expect(scratch).toBe('FROM scratch\nCOPY . /\n');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('no declared output directory still ships the scope, and lifts nothing', async () => {
    const { outputs, workspace } = await runArm({
      artifactType: 'files',
      scopeFiles: { 'index.html': '<!doctype html>' },
    });
    try {
      expect(outputs.lift).toBeUndefined();
      expect(outputs.context).toBe(join(workspace, 'bundle', 'site'));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('the platform’s own build output hands the scope to the platform’s builder', async () => {
    const { outputs, workspace } = await runArm({
      artifactType: 'vercel-output',
      // A Dockerfile in the scope decides nothing here: the platform's builder
      // is the frontend for this shape, and §5's ladder never runs.
      scopeFiles: { 'package.json': '{}', Dockerfile: 'FROM nginx' },
      vercelFramework: 'nextjs',
    });
    try {
      expect(outputs.vercelscope).toBe(join(workspace, 'bundle', 'site'));
      expect(outputs.vercelframework).toBe('nextjs');
      // The ladder's outputs are deliberately absent: nothing here is built by
      // BuildKit until the export, which `Build and push` does from the tree
      // the platform's builder leaves behind.
      expect(outputs.context).toBeUndefined();
      const scratch = await readFile(outputs.scratchfile as string, 'utf8');
      expect(scratch).toBe('FROM scratch\nCOPY . /\n');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('the platform’s build output refuses to run without a framework', async () => {
    // Core refuses this dispatch, so reaching the step at all means a spec was
    // composed by something that does not know the shape. Failing loudly beats
    // building the project as a directory of files and serving its sources.
    await expect(
      runArm({
        artifactType: 'vercel-output',
        scopeFiles: { 'package.json': '{}' },
      }),
    ).rejects.toThrow('names no framework');
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

/**
 * The platform builder step, run as the file actually ships it.
 *
 * The one behaviour worth pinning mechanically is what becomes of a symlink. A
 * framework that serves the same function under two routes emits one bundle
 * and symlinks the other at it, and `bundle.ts` admits regular files only — so
 * a link that survives into the artifact is a route that 404s on a deployment
 * which built, signed and deployed green, and a link copied out is a second
 * function the platform bills and counts. The step lifts each into a manifest
 * the deploy adapter recreates it from; nothing about either failure points
 * back here, which is exactly why it is asserted here.
 */
describe('“Build with the platform’s own builder”', () => {
  const STEP = "Build with the platform's own builder";

  async function stepScript(): Promise<string> {
    const document = Bun.YAML.parse(await Bun.file(WORKFLOW).text()) as {
      jobs: { build: { steps: { name?: string; run?: string }[] } };
    };
    const step = document.jobs.build.steps.find((s) => s.name === STEP);
    if (step?.run === undefined) {
      throw new Error(`${WORKFLOW} has no “${STEP}” step with a script`);
    }
    return step.run;
  }

  test('stages the two trees and lifts a symlinked function into the manifest', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'spindrift-vercel-arm-'));
    try {
      const scope = join(workspace, 'scope');
      const bin = join(workspace, 'bin');
      await mkdir(join(scope, 'app'), { recursive: true });
      await mkdir(bin, { recursive: true });
      await writeFile(join(scope, 'package.json'), '{}');

      // A file a function's filePathMap will name. It lives in the project,
      // outside `.vercel/output`, and has to reach the deployment root.
      await mkdir(join(scope, 'node_modules', 'dep'), { recursive: true });
      await writeFile(join(scope, 'node_modules', 'dep', 'index.js'), 'dep');

      // What Next writes for an external package: a hashed alias under
      // `.next/node_modules` that is a *symlink to a directory*, named in the
      // filePathMap. Dereferencing it is what took production down — the CLI
      // adds a map entry to the upload without walking into it, so a real
      // directory there contributes nothing and the function cannot resolve
      // the module.
      await mkdir(join(scope, '.next', 'node_modules'), { recursive: true });
      await symlink(
        '../../node_modules/dep',
        join(scope, '.next', 'node_modules', 'dep-a1b2c3'),
      );

      // Stands in for the platform's builder: writes the tree it would write,
      // including the symlinked second copy of one function that is the whole
      // point of this test, and a `.vc-config.json` naming a project file.
      await writeFile(
        join(bin, 'npx'),
        [
          '#!/usr/bin/env bash',
          'set -euo pipefail',
          'out="${PWD}/.vercel/output"',
          'mkdir -p "$out/functions/index.func" "$out/static"',
          'printf \'{"version":3}\' > "$out/config.json"',
          'printf launcher > "$out/functions/index.func/index.js"',
          'printf \'{"filePathMap":{"node_modules/dep/index.js":"node_modules/dep/index.js","x":".next/node_modules/dep-a1b2c3"}}\' > "$out/functions/index.func/.vc-config.json"',
          'printf hello > "$out/static/index.html"',
          'ln -s index.func "$out/functions/index.rsc.func"',
          'mkdir -p "$out/functions/index.segments"',
          'ln -s ../index.func "$out/functions/index.segments/_tree.segment.rsc.func"',
          '',
        ].join('\n'),
      );
      await Bun.$`chmod +x ${join(bin, 'npx')}`.quiet();

      const outputPath = join(workspace, 'github-output');
      await writeFile(outputPath, '');
      const proc = Bun.spawn(['bash', '-c', await stepScript()], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          SCOPE: scope,
          FRAMEWORK: 'nextjs',
          REQUEST_ARGS: 'PUBLIC_URL=https://app.example.test',
          SCRATCHFILE: join(workspace, 'Dockerfile'),
          RUNNER_TEMP: workspace,
          GITHUB_OUTPUT: outputPath,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      if ((await proc.exited) !== 0) {
        throw new Error(await new Response(proc.stderr).text());
      }

      const outputs: Record<string, string> = {};
      for (const line of (await readFile(outputPath, 'utf8')).split('\n')) {
        const equals = line.indexOf('=');
        if (equals > 0) outputs[line.slice(0, equals)] = line.slice(equals + 1);
      }

      const links =
        await Bun.$`find ${outputs.context as string} -type l`.text();
      expect(links.trim()).toBe('');
      // The Build Output tree is staged under `.vercel/output/` with the one
      // real function in it once, and each link recorded where the deploy
      // adapter reads it back — path from the deployment root, target exactly
      // as the builder wrote it. A dereference would pass the assertion above
      // and ship the function twice; a plain drop would lose the route.
      expect(
        await readFile(
          join(
            outputs.context as string,
            '.vercel/output/functions/index.func/index.js',
          ),
          'utf8',
        ),
      ).toBe('launcher');
      expect(
        await Bun.file(
          join(
            outputs.context as string,
            '.vercel/output/functions/index.rsc.func',
          ),
        ).exists(),
      ).toBe(false);
      const manifest = JSON.parse(
        await readFile(
          join(
            outputs.context as string,
            '.vercel/output/__spindrift/func-links.json',
          ),
          'utf8',
        ),
      ) as { path: string; target: string }[];
      expect(
        [...manifest].sort((a, b) => a.path.localeCompare(b.path)),
      ).toEqual([
        // The filePathMap alias, carried as a link rather than copied out.
        {
          path: '.next/node_modules/dep-a1b2c3',
          target: '../../node_modules/dep',
        },
        {
          path: '.vercel/output/functions/index.rsc.func',
          target: 'index.func',
        },
        {
          path: '.vercel/output/functions/index.segments/_tree.segment.rsc.func',
          target: '../index.func',
        },
      ]);
      // Never a real directory: that is the shape the CLI drops silently.
      expect(
        await Bun.file(
          join(outputs.context as string, '.next/node_modules/dep-a1b2c3'),
        ).exists(),
      ).toBe(false);

      // The mapped file is staged at the deployment root — beside
      // `.vercel/output`, never inside it, which is the path the platform
      // resolves a function's filePathMap by.
      expect(
        await readFile(
          join(outputs.context as string, 'node_modules/dep/index.js'),
          'utf8',
        ),
      ).toBe('dep');
      expect(
        await Bun.file(
          join(
            outputs.context as string,
            '.vercel/output/node_modules/dep/index.js',
          ),
        ).exists(),
      ).toBe(false);

      // The framework core resolved reaches the builder as project settings,
      // which is what stops it building the project as a directory of files.
      const link = JSON.parse(
        await readFile(join(scope, '.vercel/project.json'), 'utf8'),
      ) as { settings: { framework: string } };
      expect(link.settings.framework).toBe('nextjs');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
