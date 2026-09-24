/**
 * Runs the hosted route's files arm as the workflow ships it. `static/oci.ts`
 * reads the artifact as one gzipped tar layer, which holds only for
 * `FROM scratch` plus `COPY . /`.
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
  outputDirectory?: string;
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
        // The artifact type wins over a Dockerfile in the scope.
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
      scopeFiles: { Dockerfile: 'FROM node', 'package.json': '{}' },
      outputDirectory: 'dist',
    });
    try {
      expect(outputs.lift).toBe('dist');
      expect(outputs.context).toBe(join(workspace, 'bundle'));
      expect(outputs.file).toBe(
        join(workspace, 'bundle', 'site', 'Dockerfile'),
      );
      // Written on both paths, since each exports one directory as one layer.
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
      scopeFiles: { 'package.json': '{}', Dockerfile: 'FROM nginx' },
      vercelFramework: 'nextjs',
    });
    try {
      expect(outputs.vercelscope).toBe(join(workspace, 'bundle', 'site'));
      expect(outputs.vercelframework).toBe('nextjs');
      // BuildKit builds nothing here until `Build and push` exports the tree.
      expect(outputs.context).toBeUndefined();
      const scratch = await readFile(outputs.scratchfile as string, 'utf8');
      expect(scratch).toBe('FROM scratch\nCOPY . /\n');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('the platform’s build output refuses to run without a framework', async () => {
    // Core refuses this dispatch, so only a malformed spec reaches the step.
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
 * A framework serves one function under two routes by symlinking one bundle at
 * the other, and `bundle.ts` admits regular files only. The step records each
 * link in a manifest the deploy adapter recreates it from.
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

      // Named by a function's filePathMap, and outside `.vercel/output`.
      await mkdir(join(scope, 'node_modules', 'dep'), { recursive: true });
      await writeFile(join(scope, 'node_modules', 'dep', 'index.js'), 'dep');

      // Next aliases an external package as a symlink to a directory. The CLI
      // uploads the map entry without entering it, so a real directory is lost.
      await mkdir(join(scope, '.next', 'node_modules'), { recursive: true });
      await symlink(
        '../../node_modules/dep',
        join(scope, '.next', 'node_modules', 'dep-a1b2c3'),
      );

      // Stands in for the platform's builder.
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
      // A dereference would pass the check above but ship the function twice,
      // and a plain drop would lose the route.
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
      expect(
        await Bun.file(
          join(outputs.context as string, '.next/node_modules/dep-a1b2c3'),
        ).exists(),
      ).toBe(false);

      // The platform resolves a filePathMap from the deployment root.
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

      // Without a framework, the builder treats the project as plain files.
      const link = JSON.parse(
        await readFile(join(scope, '.vercel/project.json'), 'utf8'),
      ) as { settings: { framework: string } };
      expect(link.settings.framework).toBe('nextjs');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
