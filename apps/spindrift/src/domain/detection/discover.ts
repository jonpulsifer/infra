/**
 * The "discover" branch (§5, story 23).
 *
 * §5 is emphatic that **the scope is named, never searched** — an App is a repo
 * plus a subpath, and detection is one algorithm over one directory. This
 * module does not weaken that. It answers a different question, the one story
 * 23 puts on the front page beside *service*, *website*, *upload* and *link a
 * repo*: **what is in here?**
 *
 * The distinction is where the answer goes. Discovery proposes a list of
 * candidate directories for a human to choose from; whatever they choose
 * becomes a named scope, and detection runs over that one directory exactly as
 * it would have if the name had been typed. Nothing here reaches an App, a
 * Component, or a `spindrift.yaml`. It reaches a screen.
 *
 * It exists because the alternative is a text field. A developer connecting a
 * monorepo knows where their app is and should not have to spell it, and a
 * developer connecting a single-app repository should never see the question at
 * all.
 */
import {
  type DetectionResult,
  detectScope,
  type ZeroConfigPlanner,
} from './ladder.ts';
import type { SourceTree } from './tree.ts';
import { workspaceDirectories } from './watch-paths.ts';

/**
 * Directories whose contents are never somebody's app.
 *
 * Checked as a path segment anywhere in the path, not as a prefix: a
 * `node_modules` six levels down is as uninteresting as one at the root, and a
 * vendored tree can hold thousands of manifests that would otherwise each
 * become a candidate.
 */
const IGNORED_SEGMENTS = new Set([
  'node_modules',
  'vendor',
  'third_party',
  'testdata',
  'fixtures',
  '.git',
  '.next',
  '.output',
  '.venv',
  'dist',
  'build',
  'target',
  'out',
]);

/** A file whose presence in a directory makes that directory a candidate. */
const CANDIDATE_MANIFESTS = new Set([
  'package.json',
  'go.mod',
  'Cargo.toml',
  'pyproject.toml',
  'requirements.txt',
  'Gemfile',
  'Dockerfile',
]);

/**
 * How deep a candidate may sit below the root.
 *
 * ponytail: fixed at 2, which covers `apps/web` and `services/api` and every
 * other two-level convention, and stops a deep tree from turning discovery into
 * a hundred tiles. Raise it, or replace it with a real project-graph read, if a
 * repository shows up that genuinely nests deeper.
 */
const MAX_DEPTH = 2;

/** How many candidates are worth showing before the list stops being a choice. */
const MAX_CANDIDATES = 24;

function ignored(path: string): boolean {
  return path.split('/').some((segment) => IGNORED_SEGMENTS.has(segment));
}

/**
 * Candidate directories, in the order a screen should list them.
 *
 * Workspace membership wins when the repository declares it: a Bun, npm, yarn
 * or pnpm workspace has already said where its packages are, and guessing past
 * a declaration would be inventing an answer somebody wrote down. Everything
 * else falls back to a bounded walk for a directory carrying a manifest.
 *
 * The root is **not** included. The caller has already asked about it — that is
 * the first question detection answers — and discovery is what happens when the
 * root did not turn out to be the whole story.
 */
export async function discoverScopes(
  tree: SourceTree,
): Promise<readonly string[]> {
  const declared = (await workspaceDirectories(tree)).filter(
    (directory) => !ignored(directory),
  );
  if (declared.length > 0) return declared.slice(0, MAX_CANDIDATES);

  const candidates = new Set<string>();
  for (const path of await tree.paths()) {
    if (ignored(path)) continue;
    const segments = path.split('/');
    const file = segments.pop();
    if (file === undefined || !CANDIDATE_MANIFESTS.has(file)) continue;
    if (segments.length === 0 || segments.length > MAX_DEPTH) continue;
    candidates.add(segments.join('/'));
  }
  return [...candidates].sort().slice(0, MAX_CANDIDATES);
}

/**
 * Everything one repository has to say about itself, in one pass.
 *
 * The shape of the answer is the whole point and it is not a list of Apps: it
 * is a list of {@link DetectionResult}, unsupported outcomes included. A
 * directory Spindrift could not make sense of stays on the list wearing its
 * reason (§3's grammar), because the screen this feeds has to be able to say
 * *why not here* as readily as *here*.
 *
 * Named scopes are honoured exactly as given — that is §5's "named, never
 * searched". Discovery only happens when nobody named anything **and** the root
 * turned out not to be an App on its own, which is the one case where the
 * alternative is asking a developer to type a path they should not have to.
 *
 * Shared by `inspectRepository` and `connectRepository` so the screen and the
 * pull request cannot disagree about what is in the repository. They still each
 * run it, against their own resolved commit: showing one answer and writing
 * another is the failure this is shaped to prevent, not the round trip.
 */
export async function scanRepository(
  tree: SourceTree,
  planner: ZeroConfigPlanner,
  scopes?: readonly string[],
): Promise<readonly DetectionResult[]> {
  const inspect = (scope: string) =>
    detectScope({ tree, source: { kind: 'repo', subpath: scope }, planner });

  if (scopes !== undefined) return Promise.all(scopes.map(inspect));

  const root = await inspect('.');
  if (root.outcome === 'detected') return [root];
  return [
    root,
    ...(await Promise.all((await discoverScopes(tree)).map(inspect))),
  ];
}
