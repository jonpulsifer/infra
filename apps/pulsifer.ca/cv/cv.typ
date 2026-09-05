// Classic editorial CV. Body copy comes from dist/body.typ (pandoc + cv.lua); compile with --root set to the app dir.

#let accent = rgb("#4a2f9e")
#let violet = rgb("#8b5cf6")
#let ink = rgb("#16121f")
#let muted = rgb("#6c6680")
#let hair = rgb("#cbc5da")
#let serif = "Source Serif Pro"
#let sans = "Source Sans Pro"
#let marg = 1.15in
#let gap = 0.2in

#set document(title: "Jonathan Pulsifer — Curriculum Vitae", author: "Jonathan Pulsifer")
#set page(
  paper: "us-letter",
  margin: (left: 1.95in, right: 0.9in, top: 0.85in, bottom: 0.85in),
  footer: context {
    set text(font: sans, size: 8pt, fill: muted, tracking: 0.06em)
    pad(left: -marg, grid(
      columns: (1fr, auto),
      smallcaps[jonathan pulsifer · curriculum vitae],
      counter(page).display("1 / 1", both: true),
    ))
  },
)
#set text(font: serif, size: 10pt, fill: ink, lang: "en", number-type: "old-style", costs: (runt: 1000%, hyphenation: 40%))
#set par(
  justify: true, leading: 0.55em, spacing: 0.75em,
  justification-limits: (spacing: (min: 90%, max: 140%), tracking: (min: -0.02em, max: 0.02em)),
)
#set list(marker: text(fill: accent, size: 9pt, baseline: -0.5pt)[•], indent: 0.2em, body-indent: 0.6em, spacing: 0.45em)
#set strong(delta: 200)
#show raw: set text(font: "JetBrains Mono", size: 0.92em)
#show link: set text(fill: accent)

#let small(body) = text(font: sans, style: "normal", weight: "regular", size: 8.5pt, tracking: 0.05em, smallcaps(all: true, body))
#let mdate(d, fill: accent) = box(width: 0pt)[#h(-marg)#box(width: marg - gap, align(right, text(fill: fill, number-width: "tabular", small(d))))]
#let plain-links(body) = { show link: set text(fill: ink); body }

#let section(title) = block(sticky: true, width: 100%, above: 22pt, below: 10pt, pad(left: -marg)[
  #text(font: sans, size: 10pt, weight: "semibold", fill: accent, tracking: 0.16em, smallcaps(all: true, title))
  #v(-4pt)
  #line(length: 100%, stroke: 0.5pt + hair)
])
#let employer(name, date) = block(sticky: true, above: 14pt, below: 6pt, {
  set text(font: sans, weight: "semibold", size: 12.5pt)
  mdate(date); plain-links(name)
})
#let org(name) = block(sticky: true, above: 12pt, below: 3pt, {
  set text(font: sans, weight: "semibold", size: 10pt, fill: muted)
  plain-links(name)
})
#let role(title, date) = block(sticky: true, above: 9pt, below: 4pt, {
  set text(font: sans, weight: "semibold", size: 10.5pt)
  mdate(date, fill: muted); title
})
#let achievements(title) = block(sticky: true, above: 10pt, below: 5pt, text(font: sans, size: 8.5pt, weight: "semibold", fill: muted, tracking: 0.08em, smallcaps(all: true, title)))
#let achievement(title, body) = block(above: 6pt, below: 6pt, breakable: false, width: 100%,
  pad(left: -11pt, block(width: 100%, stroke: (left: 1.5pt + violet), inset: (left: 10pt, top: 1pt, bottom: 1.5pt),
    [#text(weight: "semibold", title) \ #text(style: "italic", fill: ink.lighten(20%), body)])))
#let lede(body) = block(par(leading: 0.6em, text(size: 11pt, body)))
#let keep(body) = block(breakable: false, width: 100%, body)
#let twoup(a, b) = {
  set par(justify: false)
  set text(hyphenate: false)
  grid(columns: (1fr, 1fr), column-gutter: 0.18in, a, b)
}

// Masthead
#pad(left: -marg)[
  #text(font: serif, size: 27pt, weight: "semibold", tracking: -0.01em)[Jonathan Pulsifer]
  #v(2pt)
  #text(style: "italic", size: 11pt, fill: muted)[securing the cloud since it was just someone else's computer]
  #v(4pt)
  #{
    let sep = h(0.7em) + text(fill: muted)[·] + h(0.7em)
    text(font: sans, size: 9pt, tracking: 0.04em)[#link("https://pulsifer.ca")[pulsifer.ca]#sep#link("https://github.com/jonpulsifer")[github.com/jonpulsifer]#sep#link("https://linkedin.com/in/jonpulsifer")[linkedin.com/in/jonpulsifer]]
  }
  #v(8pt)
  #line(length: 100%, stroke: 1pt + ink)
  #v(-5pt)
  #line(length: 100%, stroke: 0.4pt + ink)
]

#eval(read("/dist/body.typ"), mode: "markup", scope: (section: section, lede: lede, employer: employer, org: org, role: role, achievements: achievements, achievement: achievement, twoup: twoup, keep: keep))
