/**
 * Which directory a scope's Dockerfile builds from (§5).
 *
 * Two conventions share one instruction set. A monorepo Dockerfile is written
 * against the root that `docker build -f apps/x/Dockerfile .` gives it —
 * `COPY . .` then a path *into* the app — while a standalone repository's
 * Dockerfile is written against its own directory (`COPY go.mod ./` with
 * go.mod beside it), and keeps that shape when the repository is vendored
 * under a subpath. Handing either kind the other's context fails deep inside
 * the build on a path that names neither convention.
 *
 * The file itself is the tiebreak: a COPY/ADD source that resolves beside the
 * Dockerfile and not at the repository root is a Dockerfile naming its own
 * directory. Anything the rule cannot read — stage copies, URLs, globs,
 * variables — decides nothing, so the answer only ever moves off the root
 * convention on positive evidence.
 *
 * The build routes run the same rule in shell: `DOCKERFILE_CONTEXT_PROBE` in
 * `adapters/build/buildkit.ts`, carried verbatim by the hosted workflow. This
 * is the inspect-time mirror that puts the same answer in the operator's
 * sentence, and `test/adapters/dockerfile-context-arm.test.ts` holds the two
 * halves to one answer — what the operator reads at connect time must be what
 * the build then does.
 */
import type { SourceTree } from './tree.ts';

/**
 * The COPY/ADD sources of a Dockerfile that could decide its context.
 *
 * One line is one instruction: a source hidden behind a `\` continuation is
 * simply not seen, which errs toward the root convention rather than toward a
 * different answer than the shell probe would give — both read line-wise.
 */
export function contextSources(dockerfile: string): readonly string[] {
  const sources: string[] = [];
  for (const line of dockerfile.split('\n')) {
    const tokens = line.split(/[ \t]+/).filter((token) => token !== '');
    const instruction = tokens.shift()?.toUpperCase();
    if (instruction !== 'COPY' && instruction !== 'ADD') continue;
    let stage = false;
    while (tokens.length > 0 && tokens[0]!.startsWith('--')) {
      if (tokens[0]!.startsWith('--from=')) stage = true;
      tokens.shift();
    }
    // A stage copy reads another image, never the context.
    if (stage) continue;
    // The last token is the destination.
    tokens.pop();
    for (const token of tokens) {
      if (
        token === '.' ||
        token.startsWith('/') ||
        token.includes(':') ||
        token.includes('..') ||
        /[*?[]/.test(token)
      ) {
        continue;
      }
      sources.push(token.startsWith('./') ? token.slice(2) : token);
    }
  }
  return sources;
}

export type DockerfileBuildContext =
  | { readonly context: 'root' }
  | {
      readonly context: 'scope';
      /** The first source that resolves beside the Dockerfile and not at the root. */
      readonly copies: string;
    };

/** Decide the context for the Dockerfile at `prefix`, `.` meaning the root. */
export async function dockerfileBuildContext(
  tree: SourceTree,
  prefix: string,
): Promise<DockerfileBuildContext> {
  if (prefix === '.') return { context: 'root' };
  const text = await tree.readText(`${prefix}/Dockerfile`);
  if (text === null) return { context: 'root' };
  const paths = await tree.paths();
  // A source may name a directory, and tree paths name files only.
  const present = (path: string): boolean => {
    const clean = path.replace(/\/+$/, '');
    return paths.some(
      (entry) => entry === clean || entry.startsWith(`${clean}/`),
    );
  };
  for (const source of contextSources(text)) {
    if (present(`${prefix}/${source}`) && !present(source)) {
      return { context: 'scope', copies: source };
    }
  }
  return { context: 'root' };
}
