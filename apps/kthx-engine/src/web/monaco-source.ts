/**
 * Monaco's `min/vs` tree in the installed package. The package is a build
 * input, so only `build.ts`, `dev.ts` and tests read this; `server.ts` serves
 * the copy in `dist/`.
 */
import { dirname, join } from 'node:path';
import { MONACO_VERSION } from './monaco-path.ts';

export async function monacoSource(): Promise<string> {
  const manifest = Bun.resolveSync(
    'monaco-editor/package.json',
    import.meta.dir,
  );
  const { version } = (await Bun.file(manifest).json()) as { version: string };
  if (version !== MONACO_VERSION) {
    throw new Error(
      `installed monaco-editor is ${version}, but the console serves ${MONACO_VERSION}`,
    );
  }
  return join(dirname(manifest), 'min/vs');
}
