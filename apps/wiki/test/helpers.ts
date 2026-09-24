import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../build";

const FIXTURES = join(import.meta.dir, "fixtures");

/** Builds a copy of the fixture tree with `edits` applied: keys are paths under docs/, and null deletes the file. */
export async function site(edits: Record<string, string | null> = {}, check = false) {
  const dir = await mkdtemp(join(tmpdir(), "wiki-"));
  await cp(FIXTURES, dir, { recursive: true });
  for (const [file, body] of Object.entries(edits)) {
    const path = join(dir, "docs", file);
    if (body === null) await rm(path);
    else await Bun.write(path, body);
  }
  const out = join(dir, "dist");
  const result = await build({ docs: join(dir, "docs"), out, repo: dir, assets: [join(dir, "docs", "assets")], check });
  return {
    ...result,
    read: (file: string) => Bun.file(join(out, file)).text(),
    json: (file: string) => Bun.file(join(out, file)).json(),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

export const page = (front: string, body = "Text.\n") => `---\n${front}\n---\n\n${body}`;
