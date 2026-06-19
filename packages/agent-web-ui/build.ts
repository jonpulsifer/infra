import { $ } from "bun";
import { cpSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";

const outdir = "dist";

// Ensure output directories exist
mkdirSync(join(outdir, "icons"), { recursive: true });
mkdirSync(join(outdir, "fonts"), { recursive: true });

// 1. Build CSS with Tailwind
console.log("Building CSS...");
await $`bunx @tailwindcss/cli -i src/styles/main.css -o ${outdir}/styles.css --minify`;

// 2. Bundle JS (mark ghostty-web imports as external — they resolve at runtime in the browser)
console.log("Building JS...");
const result = await Bun.build({
  entrypoints: ["src/scripts/landing.ts", "src/scripts/terminal.ts"],
  outdir,
  minify: true,
  external: ["/dist/*"],
});

if (!result.success) {
  console.error("Build failed:", result.logs);
  process.exit(1);
}

// 3. Copy HTML templates (not minified — server needs to inject <!--__SERVER_CONFIG__-->)
console.log("Copying HTML...");
cpSync("src/pages/landing.html", join(outdir, "landing.html"));
cpSync("src/pages/terminal.html", join(outdir, "terminal.html"));

// 4. Copy icons
console.log("Copying icons...");
for (const file of readdirSync("src/icons")) {
  cpSync(join("src/icons", file), join(outdir, "icons", file));
}

// 5. Copy fonts
console.log("Copying fonts...");
for (const file of readdirSync("public/fonts")) {
  cpSync(join("public/fonts", file), join(outdir, "fonts", file));
}

console.log("Build complete → dist/");
