/**
 * spindrift-demo build — inject build-time vars into the static site.
 *
 * Reads git commit/branch, stamps the current time, replaces placeholders in
 * the HTML template, and copies everything to dist/.
 */
import { readFile, mkdir, rm, cp } from 'node:fs/promises';
import { join } from 'node:path';

const SRC = join(import.meta.dir, 'src');
const OUT = join(import.meta.dir, 'dist');

// ── build-time facts ────────────────────────────────────────────────────────

const commit =
  Bun.env.BUILD_COMMIT ||
  (() => {
    const proc = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return proc.stdout.toString().trim() || 'unknown';
  })();

const branch =
  Bun.env.BUILD_BRANCH ||
  (() => {
    const proc = Bun.spawnSync(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return proc.stdout.toString().trim() || 'unknown';
  })();

const stamp = Bun.env.BUILD_TIME || new Date().toISOString();

// ── inject ──────────────────────────────────────────────────────────────────

let html = await readFile(join(SRC, 'index.html'), 'utf-8');
html = html.replace('<!--BUILD_COMMIT-->', escapeHtml(commit));
html = html.replace('<!--BUILD_BRANCH-->', escapeHtml(branch));
html = html.replace('<!--BUILD_TIME-->', escapeHtml(stamp));

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char]!,
  );
}

// ── emit ────────────────────────────────────────────────────────────────────

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

await Bun.write(join(OUT, 'index.html'), html);
await cp(join(SRC, 'style.css'), join(OUT, 'style.css'));
await cp(join(SRC, 'client.js'), join(OUT, 'client.js'));
await cp(join(SRC, 'runtime.js'), join(OUT, 'runtime.js'));
await cp(join(SRC, 'logos'), join(OUT, 'logos'), { recursive: true });

console.log(`spindrift-demo → dist/ (commit ${commit} on ${branch})`);
