/**
 * Which directory a scope's Dockerfile builds from: the scope when a COPY/ADD
 * source exists beside it and not at the root, else the root. Keep it in step
 * with `DOCKERFILE_CONTEXT_PROBE` in `adapters/build/buildkit.ts`.
 */
import type { SourceTree } from './tree.ts';

/** Line by line, like the shell probe, so a source after a line continuation is not seen. */
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
      const source = token.startsWith('./') ? token.slice(2) : token;
      // `COPY ./ <dest>` names the whole context, like `.`, so it is no evidence.
      if (source === '') continue;
      sources.push(source);
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

/** `prefix` is the Dockerfile's directory; `.` means the root. */
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
