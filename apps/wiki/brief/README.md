# Purchase-to-identity brief

This static presentation reads the canonical page at
`docs/reference/purchase-to-identity.md` through the wiki renderer. Edit that
page for content changes. `build.ts` adds expandable lifecycle stages, section
navigation and a source revision. `style.css` supplies responsive and print
layouts. The output uses no client JavaScript or backend.

From the repository root, build committed canonical content:

```sh
mise run docs:brief
```

The output is `apps/wiki/brief/dist/`. The build preserves deployment metadata
in that directory. The diagram is local; fonts load from Google Fonts with
system-font fallbacks. Links to deeper evidence point at the wiki.

To claim a new kthx site and publish, use authenticated Google Application
Default Credentials:

```sh
mise run kthx -- init --name folly-trust apps/wiki/brief/dist
mise run kthx -- deploy apps/wiki/brief/dist
```

For subsequent updates, rebuild and deploy the same directory. If the name is
already owned elsewhere, inspect ownership before changing it. Keep deployment
metadata out of commits. See `.agents/skills/publish-on-kthx/SKILL.md`.

Validation:

```sh
bun run --cwd apps/wiki test
mise run docs:check
mise run docs:build
mise run docs:brief
```
