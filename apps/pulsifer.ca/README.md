# pulsifer.ca

hi, this is my personal website, available at https://pulsifer.ca

## hugo + tailwind

this site is built using https://gohugo.io and published to GitHub pages.
styles are Tailwind CSS v4, compiled by the standalone CLI into
`assets/css/built.css` (gitignored) — the source of truth is `css/main.css`
and the layouts in `themes/wip/`.

### contributing

1. `mise install` in this directory (provides pinned `hugo` and `tailwindcss`)
1. `mise run serve` — compiles CSS and runs the dev server
1. editing styles? run `mise run css-watch` in a second terminal
1. view your changes at http://localhost:1313
1. `mise run build` for the full production build
1. commit your changes
1. open a pr
1. :godmode:
