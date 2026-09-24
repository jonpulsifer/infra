# pulsifer.ca

The personal website at https://pulsifer.ca: a Hugo site styled with Tailwind
CSS v4. See [pulsifer.ca](https://wiki.lolwtf.ca/apps/pulsifer-ca/).

## Run

Run these tasks in this directory. `mise install` supplies the pinned `hugo`,
`tailwindcss`, `pandoc` and `typst`.

```bash
mise install
mise run serve       # compile the CSS and the CV, then serve on http://localhost:1313
mise run css-watch   # in a second shell, when you edit styles
mise run build       # the production build, into public/
mise run cv          # content/cv.md to static/cv.pdf
```

The Tailwind CLI compiles `css/main.css` into `assets/css/built.css`, which git
ignores. The layouts are in `themes/wip/`. `mise run cv` gets its fonts from
the flake's nixpkgs, so it needs Nix.

## Deploy

`.github/workflows/pulsifer-ca.yml` runs `mise run build` and, on `main`,
publishes `public/` to GitHub Pages.
