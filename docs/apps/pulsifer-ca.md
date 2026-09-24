---
title: pulsifer.ca
description: The owner's personal website and CV at pulsifer.ca, a Hugo site that GitHub Actions builds and GitHub Pages serves.
status: live
---

pulsifer.ca is the owner's personal website, with an about page, posts, talks and a CV. It is a Hugo site styled with Tailwind CSS. GitHub Pages serves it, and the CV is also a PDF.

## Use it

| Surface | Address | Who can reach it |
| --- | --- | --- |
| Site | `https://pulsifer.ca` | Anyone |
| CV | `https://pulsifer.ca/cv.pdf` | Anyone |

To change the site, edit the files in `apps/pulsifer.ca/content/` and merge a pull request. To preview a change, run the dev server from the app's directory. `serve` and `build` both run the `cv` task, so the preview needs Nix with flakes enabled.

```bash
cd apps/pulsifer.ca
mise install
mise run serve
```

The dev server listens on `http://localhost:1313`.

## How it works

`apps/pulsifer.ca/mise.toml` pins Hugo, the Tailwind standalone CLI, pandoc and Typst, and defines the tasks. `mise run build` compiles `css/main.css`, renders `content/cv.md` to `static/cv.pdf` with pandoc and Typst, and runs `hugo --minify`. The CV fonts come from the nixpkgs of the repository flake. The theme is in `themes/wip/`.

`.github/workflows/pulsifer-ca.yml` runs the build on each change under `apps/pulsifer.ca/`. On `main`, it pushes `public/` to the `gh-pages` branch of this repository.

Cloudflare holds the `pulsifer.ca` zone. The apex has proxied A records at the GitHub Pages addresses that GitHub's API lists, and `static/CNAME` names the domain for GitHub Pages.

## Operate

No alerts watch the site.

## Reference

- Source: `apps/pulsifer.ca/`
- Deploy: `.github/workflows/pulsifer-ca.yml`
- DNS: `terraform/network/cloudflare/pulsifer.ca.tf`
