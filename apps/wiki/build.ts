/**
 * Renders docs/ (Markdown with YAML frontmatter, ordered by docs/nav.yaml) to a
 * static site in dist/, with search.json, graph.json and the pages.json that
 * functions/mcp.ts serves. `--check` validates without writing dist/.
 */
import { existsSync, statSync } from "node:fs";
import { cp, rm } from "node:fs/promises";
import { join, posix, relative } from "node:path";
import { codeToHtml } from "shiki";

const REPO = "https://github.com/jonpulsifer/infra";
const SITE = "https://wiki.lolwtf.ca";
const ROOT = join(import.meta.dir, "..", "..");
const KEYS = ["title", "description", "status", "cards", "specs"];
const STATUSES = ["live", "parked", "experiment", "unplugged", "off-git", "unverified"];
const ALERT = /^<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\n|(?=<\/p>))/i;
const FAVICON =
  "data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🛰️</text></svg>";

export interface Options {
  docs: string;
  out: string;
  repo: string;
  /** Directories merged and served at /assets/. */
  assets: string[];
  check?: boolean;
}

export const defaults = (): Options => ({
  docs: join(ROOT, "docs"),
  out: join(import.meta.dir, "dist"),
  repo: ROOT,
  // The kthx image build prunes to its own package, so its diagrams live there.
  assets: [
    join(ROOT, "docs", "assets"),
    join(ROOT, "apps", "spindrift", "src", "web", "client", "diagrams"),
  ],
});

interface Heading {
  level: number;
  id: string;
  text: string;
}
interface NavPage {
  file: string;
  children: NavPage[];
}
interface NavGroup {
  group: string;
  items: NavPage[];
}
interface Section {
  id: string;
  title: string;
  index?: string;
  items: (NavPage | NavGroup)[];
}
export interface Page {
  file: string;
  path: string;
  url: string;
  title: string;
  description: string;
  status?: string;
  cards: string[];
  specs: [string, string][];
  markdown: string;
  section?: Section;
  html: string;
  text: string;
  headings: Heading[];
  code: { code: string; lang: string }[];
}
interface Link {
  from: Page;
  to: Page;
  anchor: string;
  href: string;
}
interface Ctx {
  o: Options;
  pages: Map<string, Page>;
  sections: Section[];
  order: Page[];
  links: Link[];
  fail: (file: string, msg: string) => void;
}

const ENT: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ENT[c]);
const unesc = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|#39);/g, (e) => Object.keys(ENT).find((k) => ENT[k] === e)!);
const inline = (html: string) => unesc(html.replace(/<[^>]*>/g, "")).trim();
const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
const list = (v: unknown): unknown[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

/** github-slugger: lowercase, drop punctuation, spaces to hyphens. */
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
    .replace(/ /g, "-");

function parsePage(file: string, raw: string, fail: Ctx["fail"]): Page {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  let fm: Record<string, unknown> = {};
  if (!m) fail(file, "no frontmatter; start the file with a --- block holding title and description");
  else {
    try {
      const v = Bun.YAML.parse(m[1]);
      if (v && typeof v === "object" && !Array.isArray(v)) fm = v as Record<string, unknown>;
      else fail(file, "frontmatter must be a YAML map");
    } catch (e) {
      fail(file, `frontmatter is not valid YAML: ${(e as Error).message}`);
    }
  }
  for (const k of Object.keys(fm)) if (!KEYS.includes(k)) fail(file, `unknown frontmatter key "${k}" (allowed: ${KEYS.join(", ")})`);
  for (const k of ["title", "description"])
    if (typeof fm[k] !== "string" || !fm[k].trim()) fail(file, `frontmatter needs a ${k}`);
  const status = fm.status == null ? undefined : String(fm.status);
  if (status && !STATUSES.includes(status)) fail(file, `status "${status}" is not one of ${STATUSES.join(", ")}`);
  const specs = fm.specs ?? {};
  if (typeof specs !== "object" || Array.isArray(specs) || Object.values(specs).some((v) => typeof v === "object"))
    fail(file, "specs must be a map of name: value");
  if (!file.replace(/\.md$/, "").split("/").every((s) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)))
    fail(file, "file names are lowercase kebab-case");
  const path = file.replace(/\.md$/, "").replace(/(?:^|\/)index$/, "");
  return {
    file,
    path,
    url: path ? `/${path}/` : "/",
    title: String(fm.title ?? ""),
    description: String(fm.description ?? ""),
    status,
    cards: list(fm.cards).map(String),
    specs: Object.entries(specs as object).map(([k, v]) => [k, String(v)]),
    markdown: m ? raw.slice(m[0].length) : raw,
    html: "",
    text: "",
    headings: [],
    code: [],
  };
}

function readNav(raw: unknown, pages: Map<string, Page>, fail: Ctx["fail"]): Section[] {
  const seen = new Set<string>();
  const entry = (v: unknown): NavPage[] => {
    const file = typeof v === "string" ? v : (v as { path?: unknown })?.path;
    if (typeof file !== "string") {
      fail("nav.yaml", `expected a path, {path, children} or {group, items}, got ${JSON.stringify(v)}`);
      return [];
    }
    const children = list((v as { children?: unknown }).children).flatMap(entry);
    if (file === "index.md") fail("nav.yaml", "index.md is the root page; leave it out of the nav");
    else if (!pages.has(file)) fail("nav.yaml", `${file} has no file`);
    else if (seen.has(file)) fail("nav.yaml", `${file} is listed twice`);
    else {
      seen.add(file);
      return [{ file, children }];
    }
    return [];
  };
  const sections = list((raw as { sections?: unknown })?.sections).map((s) => {
    const { title, index, items } = (s ?? {}) as Record<string, unknown>;
    if (typeof title !== "string") fail("nav.yaml", `section without a title: ${JSON.stringify(s)}`);
    if (index != null && typeof index !== "string")
      fail("nav.yaml", `${title} index must be a path; put children under an item instead`);
    return {
      id: String(title).toLowerCase(),
      title: String(title),
      index: typeof index === "string" ? entry(index)[0]?.file : undefined,
      items: list(items).flatMap((i): (NavPage | NavGroup)[] => {
        const g = i as { group?: unknown; items?: unknown };
        return g && typeof g === "object" && "group" in g
          ? [{ group: String(g.group), items: list(g.items).flatMap(entry) }]
          : entry(i);
      }),
    };
  });
  return sections;
}

function navOrder(ctx: Ctx): Page[] {
  const order: Page[] = [];
  const add = (n: NavPage, s: Section) => {
    const p = ctx.pages.get(n.file)!;
    p.section = s;
    order.push(p);
    for (const c of n.children) add(c, s);
  };
  const root = ctx.pages.get("index.md");
  if (root) order.push(root);
  for (const s of ctx.sections) {
    if (s.index) add({ file: s.index, children: [] }, s);
    for (const i of s.items) for (const n of "group" in i ? i.items : [i]) add(n, s);
  }
  return order;
}

function resolve(raw: string, p: Page, ctx: Ctx, image: boolean): string {
  if (/^[a-z][a-z\d+.-]*:|^\/\//i.test(raw)) {
    if ((image ? /^https?:\/\//i : /^(?:https?:\/\/|mailto:)/i).test(raw)) return raw;
    ctx.fail(p.file, `${raw}: ${image ? "images" : "links"} take ${image ? "http(s)" : "http(s) or mailto"} URLs or relative paths`);
    return "#";
  }
  const hash = raw.indexOf("#");
  const target = hash < 0 ? raw : raw.slice(0, hash);
  const anchor = hash < 0 ? "" : raw.slice(hash + 1);
  if (!target) {
    ctx.links.push({ from: p, to: p, anchor, href: raw });
    return raw;
  }
  if (target.startsWith("/")) {
    ctx.fail(p.file, `${raw}: link with a relative path, not a site path`);
    return raw;
  }
  const rel = posix.normalize(posix.join(posix.dirname(p.file), decode(target)));
  const to = ctx.pages.get(rel) ?? ctx.pages.get(posix.join(rel, "index.md"));
  if (to && !image) {
    ctx.links.push({ from: p, to, anchor, href: raw });
    return to.url + (anchor ? `#${anchor}` : "");
  }
  const asset = rel.replace(/^assets\//, "");
  if (asset !== rel && !rel.endsWith(".d2") && ctx.o.assets.some((d) => existsSync(join(d, asset))))
    return `/${rel}`;
  if (image) {
    ctx.fail(p.file, `image ${raw} is not in docs/assets`);
    return raw;
  }
  const abs = join(ctx.o.docs, rel);
  const repoPath = relative(ctx.o.repo, abs);
  if (repoPath.startsWith("..") || !existsSync(abs)) {
    ctx.fail(p.file, `broken link ${raw}`);
    return raw;
  }
  const kind = statSync(abs).isDirectory() ? "tree" : "blob";
  return `${REPO}/${kind}/main/${repoPath}${hash < 0 ? "" : raw.slice(hash)}`;
}

const badge = (s?: string) => (s ? `<span class="badge" data-status="${s}">${s}</span>` : "");

function card(p: Page): string {
  return `<a class="card" href="${p.url}"><span class="card-head"><span class="card-title">${esc(p.title)}</span>${badge(p.status)}</span><span class="card-desc">${esc(p.description)}</span></a>`;
}

function cards(p: Page, ctx: Ctx, heading: (level: number, html: string) => string): string {
  let out = "";
  for (const id of p.cards) {
    const s = ctx.sections.find((x) => x.id === id);
    if (!s) {
      ctx.fail(p.file, `cards: no nav section "${id}" (have: ${ctx.sections.map((x) => x.id).join(", ")})`);
      continue;
    }
    const own = s === p.section;
    const index = s.index && ctx.pages.get(s.index);
    if (!own) out += heading(2, index ? `<a href="${index.url}">${esc(s.title)}</a>` : esc(s.title));
    let run: NavPage[] = [];
    const flush = () => {
      if (run.length) out += `<div class="cards">${run.map((n) => card(ctx.pages.get(n.file)!)).join("")}</div>\n`;
      run = [];
    };
    for (const i of s.items) {
      if (!("group" in i)) run.push(i);
      else {
        flush();
        out += heading(own ? 2 : 3, esc(i.group));
        run = i.items;
        flush();
      }
    }
    flush();
  }
  return out;
}

function render(p: Page, ctx: Ctx): void {
  const seen = new Map<string, number>();
  const heading = (level: number, html: string) => {
    const text = inline(html);
    const base = slug(text);
    let id = base;
    while (seen.has(id)) {
      seen.set(base, seen.get(base)! + 1);
      id = `${base}-${seen.get(base)}`;
    }
    seen.set(id, 0);
    p.headings.push({ level, id, text });
    return `<h${level} id="${id}">${html}<a class="hash" href="#${id}" aria-label="Link to this section">#</a></h${level}>\n`;
  };
  const cell = (tag: string, c: string, m?: { align?: string }) =>
    `<${tag}${m?.align ? ` style="text-align:${m.align}"` : ""}>${c}</${tag}>`;
  const body = Bun.markdown.render(
    p.markdown,
    {
      text: esc,
      heading: (c, { level }) => {
        if (level === 1) ctx.fail(p.file, `H1 "${inline(c)}" in the body; the title is the H1, so start sections at ##`);
        return heading(level, c);
      },
      paragraph: (c) => `<p>${c}</p>\n`,
      blockquote: (c) => {
        const m = c.match(ALERT);
        if (!m) return `<blockquote>${c}</blockquote>\n`;
        const rest = c.slice(m[0].length);
        const inner = rest.startsWith("</p>") ? rest.slice(4) : `<p>${rest}`;
        const kind = m[1].toLowerCase();
        return `<div class="alert ${kind}" role="note"><p class="alert-title">${kind}</p>${inner}</div>\n`;
      },
      code: (c, m) => `\0${p.code.push({ code: unesc(c), lang: m?.language ?? "" }) - 1}\0`,
      list: (c, m) =>
        m.ordered ? `<ol${m.start && m.start !== 1 ? ` start="${m.start}"` : ""}>${c}</ol>\n` : `<ul>${c}</ul>\n`,
      listItem: (c, m) =>
        m.checked === undefined
          ? `<li>${c}</li>`
          : `<li class="task"><input type="checkbox" disabled${m.checked ? " checked" : ""} aria-label="${m.checked ? "done" : "to do"}"> ${c}</li>`,
      hr: () => "<hr>\n",
      table: (c) => `<div class="table"><table>${c}</table></div>\n`,
      thead: (c) => `<thead>${c}</thead>`,
      tbody: (c) => `<tbody>${c}</tbody>`,
      tr: (c) => `<tr>${c}</tr>`,
      th: (c, m) => cell("th", c, m),
      td: (c, m) => cell("td", c, m),
      strong: (c) => `<strong>${c}</strong>`,
      emphasis: (c) => `<em>${c}</em>`,
      strikethrough: (c) => `<del>${c}</del>`,
      codespan: (c) => `<code>${c}</code>`,
      link: (c, { href, title }) => {
        // Autolinked www. and email addresses arrive without a scheme.
        if (c === esc(href) && /^www\./.test(href)) href = `https://${href}`;
        else if (c === esc(href) && /^[^\s/:]+@[^\s/:]+\.[a-z]+$/i.test(href)) href = `mailto:${href}`;
        const url = resolve(href, p, ctx, false);
        const ext = /^https?:/.test(url) ? ' rel="noopener"' : "";
        // Anchors cannot nest, so a linked image drops its own fig anchor.
        const inner = c.replace(/<a class="fig" href="[^"]*">(<img [^>]*>)<\/a>/g, "$1");
        return `<a href="${esc(url)}"${title ? ` title="${esc(title)}"` : ""}${ext}>${inner}</a>`;
      },
      image: (c, { src, title }) => {
        const url = esc(resolve(src, p, ctx, true));
        // Linked to itself: a diagram shrunk to the column loses its labels.
        return `<a class="fig" href="${url}"><img src="${url}" alt="${c.replace(/<[^>]*>/g, "")}"${title ? ` title="${esc(title)}"` : ""} loading="lazy"></a>`;
      },
    },
    // With no html callback, raw HTML reaches `text` and is escaped. Spans stay
    // on because <https://…> autolinks are parsed as HTML spans.
    { noHtmlBlocks: true, autolinks: true },
  );
  if (/\[\[[^\]\n]+\]\]/.test(body.replace(/<code>[\s\S]*?<\/code>/g, "")))
    ctx.fail(p.file, "[[Page]] is Logseq syntax; link the page by its relative .md path");
  p.text = unesc(
    body
      .replace(/<a class="hash"[^>]*>#<\/a>/g, "")
      .replace(/\0(\d+)\0/g, (_, i) => ` ${esc(p.code[+i].code)} `)
      .replace(/<\/(?:p|li|h\d|t[dh]|div|blockquote)>|<hr>/g, " ")
      .replace(/<[^>]*>/g, ""),
  )
    .replace(/\s+/g, " ")
    .trim();
  p.html = body + cards(p, ctx, heading);
}

async function highlight(p: Page): Promise<void> {
  const themes = { light: "vitesse-light", dark: "vitesse-dark" };
  const blocks = await Promise.all(
    p.code.map(async ({ code, lang }) => {
      const src = code.replace(/\n$/, "");
      const html = await codeToHtml(src, { lang: lang || "text", themes, defaultColor: false }).catch(() =>
        codeToHtml(src, { lang: "text", themes, defaultColor: false }),
      );
      return `<div class="code"${lang ? ` data-lang="${esc(lang)}"` : ""}>${html}</div>\n`;
    }),
  );
  p.html = p.html.replace(/\0(\d+)\0/g, (_, i) => blocks[+i]);
}

const svg = (d: string, fill = false) =>
  `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" ${fill ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'}>${d}</svg>`;
const ICON = {
  menu: svg('<path d="M4 6h16M4 12h16M4 18h16"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  theme: svg('<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor"/>'),
  github: svg(
    '<path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.26 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z"/>',
    true,
  ),
};

function sidebar(ctx: Ctx, cur?: Page): string {
  const a = (file: string, label?: string) => {
    const p = ctx.pages.get(file)!;
    return `<a href="${p.url}"${p === cur ? ' aria-current="page"' : ""}>${esc(label ?? p.title)}</a>`;
  };
  const node = (n: NavPage): string =>
    `<li>${a(n.file)}${n.children.length ? `<ul>${n.children.map(node).join("")}</ul>` : ""}</li>`;
  return ctx.sections
    .map((s) => {
      const items = s.items
        .map((i) =>
          "group" in i
            ? `<li class="group"><span class="eyebrow">${esc(i.group)}</span><ul>${i.items.map(node).join("")}</ul></li>`
            : node(i),
        )
        .join("");
      const open = !cur?.section || cur.section === s ? " open" : "";
      return `<details${open}><summary>${esc(s.title)}</summary><ul>${s.index ? `<li>${a(s.index, "Overview")}</li>` : ""}${items}</ul></details>`;
    })
    .join("\n");
}

function crumbs(p: Page, ctx: Ctx): string {
  if (!p.path) return "";
  const segs = p.path.split("/");
  const parts = ['<a href="/">Home</a>'];
  for (let i = 1; i < segs.length; i++) {
    const dir = segs.slice(0, i).join("/");
    const q = ctx.pages.get(`${dir}/index.md`) ?? ctx.pages.get(`${dir}.md`);
    parts.push(q ? `<a href="${q.url}">${esc(q.title)}</a>` : `<span>${esc(segs[i - 1])}</span>`);
  }
  parts.push(`<span aria-current="page">${esc(p.title)}</span>`);
  return `<nav class="crumbs" aria-label="Breadcrumb"><ol>${parts.map((x) => `<li>${x}</li>`).join("")}</ol></nav>`;
}

function layout(ctx: Ctx, head: { title: string; description: string; url?: string }, main: string, cur?: Page, toc = ""): string {
  const title = head.url === "/" ? "infra wiki" : `${head.title} · infra wiki`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(head.description)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(head.description)}">
${head.url ? `<link rel="canonical" href="${SITE}${head.url}">` : ""}
<link rel="icon" href="${FAVICON}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400..700&family=Geist+Mono:wght@400..600&display=swap">
<link rel="stylesheet" href="/style.css">
<script>try{const t=localStorage.getItem("theme");if(t)document.documentElement.dataset.theme=t}catch{}</script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top">
<button class="icon-btn menu" type="button" data-menu aria-controls="side" aria-expanded="false" aria-label="Menu">${ICON.menu}</button>
<a class="brand" href="/">infra<span>_</span>wiki</a>
<button class="search-btn" type="button" data-search aria-label="Search">${ICON.search}<span>Search</span><kbd>⌘K</kbd></button>
<button class="icon-btn" type="button" data-theme-toggle aria-label="Toggle dark mode">${ICON.theme}</button>
<a class="icon-btn" href="${REPO}" rel="noopener" aria-label="Source on GitHub">${ICON.github}</a>
</header>
<div class="shell">
<nav class="side" id="side" aria-label="Wiki">${sidebar(ctx, cur)}</nav>
<main class="main" id="main">
${main}
<footer class="foot">Built from <a href="${REPO}/tree/main/docs" rel="noopener">docs/</a> by <a href="${REPO}/tree/main/apps/wiki" rel="noopener">apps/wiki</a> · <a href="/graph/">Link graph</a></footer>
</main>
${toc}
</div>
<dialog class="search" aria-label="Search the wiki">
<input type="search" placeholder="Search the wiki" aria-label="Search the wiki" autocomplete="off" spellcheck="false" aria-controls="search-results">
<ul id="search-results" role="listbox" aria-label="Results"></ul>
<p class="search-hint"><kbd>↑</kbd><kbd>↓</kbd> move <kbd>↵</kbd> open <kbd>esc</kbd> close</p>
</dialog>
<script src="/client.js" defer></script>
</body>
</html>
`;
}

function pageHtml(p: Page, i: number, ctx: Ctx): string {
  const from = [...new Set(ctx.links.filter((l) => l.to === p && l.from !== p).map((l) => l.from))];
  const pager = (q: Page | undefined, label: string, cls: string) =>
    q ? `<a class="${cls}" href="${q.url}"><span class="eyebrow">${label}</span>${esc(q.title)}</a>` : "<span></span>";
  const specs = p.specs.length
    ? `<div class="table specs"><table><tbody>${p.specs.map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</tbody></table></div>`
    : "";
  const main = `${crumbs(p, ctx)}
<article class="doc">
<header class="doc-head"><h1>${esc(p.title)}</h1><p class="lead">${esc(p.description)}</p>${p.status ? `<p class="doc-meta">${badge(p.status)}</p>` : ""}</header>
${specs}
<div class="prose">
${p.html}</div>
<p class="edit"><a href="${REPO}/edit/main/${encodeURI(relative(ctx.o.repo, join(ctx.o.docs, p.file)))}" rel="noopener">Edit on GitHub</a></p>
<nav class="pager" aria-label="Previous and next">${pager(ctx.order[i - 1], "Previous", "prev")}${pager(ctx.order[i + 1], "Next", "next")}</nav>
${from.length ? `<details class="backlinks"><summary>Linked from <span class="count">${from.length}</span></summary><ul>${from.map((q) => `<li><a href="${q.url}">${esc(q.title)}</a><span>${esc(q.description)}</span></li>`).join("")}</ul></details>` : ""}
</article>`;
  const toc = p.headings.filter((h) => h.level <= 3);
  const rail = toc.length
    ? `<aside class="toc" aria-label="On this page"><p class="eyebrow">On this page</p><ul>${toc.map((h) => `<li${h.level === 3 ? ' class="sub"' : ""}><a href="#${h.id}">${esc(h.text)}</a></li>`).join("")}</ul></aside>`
    : '<aside class="toc"></aside>';
  return layout(ctx, p, main, p, rail);
}

async function emit(ctx: Ctx): Promise<void> {
  const { o, order } = ctx;
  await rm(o.out, { recursive: true, force: true });
  for (const dir of o.assets)
    if (existsSync(dir)) await cp(dir, join(o.out, "assets"), { recursive: true, filter: (s) => !s.endsWith(".d2") });
  await Promise.all(order.map(highlight));
  const write = (file: string, body: string) => Bun.write(join(o.out, file), body);
  const edges = [...new Set(ctx.links.filter((l) => l.from !== l.to).map((l) => `${order.indexOf(l.from)} ${order.indexOf(l.to)}`))].map((e) => e.split(" ").map(Number));
  const doc = (title: string, lead: string, body = "") =>
    `<article class="doc"><header class="doc-head"><h1>${title}</h1><p class="lead">${lead}</p></header>${body}</article>`;
  await Promise.all([
    ...order.map((p, i) => write(join(p.path, "index.html"), pageHtml(p, i, ctx))),
    write("404.html", layout(ctx, { title: "Not found", description: "No page at this address." }, doc("Not found", 'No page lives at this address. Try <button class="linkish" type="button" data-search>search</button> or go <a href="/">home</a>.'))),
    write("graph/index.html", layout(ctx, { title: "Link graph", description: "Every wiki page and the links between them.", url: "/graph/" }, doc("Link graph", "Every page and the links between them. Drag to pan, scroll to zoom, select a node to open it.", '<canvas id="graph" aria-label="Link graph of every wiki page"></canvas>'))),
    write("graph.json", JSON.stringify({ nodes: order.map((p) => ({ t: p.title, u: p.url, d: 1 + edges.filter((e) => e.includes(order.indexOf(p))).length })), links: edges })),
    write("search.json", JSON.stringify(order.map((p) => ({ t: p.title, d: p.description, u: p.url, s: p.section?.title ?? "", h: p.headings.filter((h) => h.level <= 3).map((h) => [h.text, h.id]), x: p.text })))),
    write("pages.json", JSON.stringify(order.map((p) => ({ path: p.path, url: p.url, title: p.title, description: p.description, section: p.section?.title ?? null, status: p.status ?? null, markdown: p.markdown })))),
    cp(join(import.meta.dir, "assets", "style.css"), join(o.out, "style.css")),
    cp(join(import.meta.dir, "assets", "client.js"), join(o.out, "client.js")),
  ]);
}

/** Every URL the site answers: pages, their heading anchors, assets and generated files. */
function served(ctx: Ctx): string[] {
  const urls = ["/404.html", "/graph/", "/graph.json", "/search.json", "/pages.json", "/style.css", "/client.js"];
  for (const p of ctx.order)
    for (const u of [p.url, ...p.headings.map((h) => `${p.url}#${h.id}`)]) urls.push(u, encodeURI(u));
  for (const dir of ctx.o.assets)
    if (existsSync(dir))
      for (const f of new Bun.Glob("**/*").scanSync({ cwd: dir })) if (!f.endsWith(".d2")) urls.push(`/assets/${f}`);
  return [...new Set(urls)].sort();
}

/** Writes nothing when `check` is set or any problem comes back in `errors`. */
export async function build(o: Options): Promise<{ pages: Page[]; errors: string[]; urls: string[] }> {
  const errors: string[] = [];
  const fail = (file: string, msg: string) => errors.push(`${relative(o.repo, join(o.docs, file))}: ${msg}`);
  const pages = new Map<string, Page>();
  const byUrl = new Map<string, string>();
  const files = [...new Bun.Glob("**/*.md").scanSync({ cwd: o.docs })].filter((f) => !f.startsWith("agents/")).sort();
  for (const file of files) {
    const p = parsePage(file, await Bun.file(join(o.docs, file)).text(), fail);
    if (byUrl.has(p.url)) fail(file, `same URL ${p.url} as ${byUrl.get(p.url)}`);
    byUrl.set(p.url, file);
    pages.set(file, p);
  }
  if (!pages.has("index.md")) fail("index.md", "missing; it is the home page");
  let nav: unknown;
  try {
    nav = Bun.YAML.parse(await Bun.file(join(o.docs, "nav.yaml")).text());
  } catch (e) {
    fail("nav.yaml", `unreadable: ${(e as Error).message}`);
  }
  const ctx: Ctx = { o, pages, sections: readNav(nav, pages, fail), order: [], links: [], fail };
  ctx.order = navOrder(ctx);
  for (const p of pages.values())
    if (!ctx.order.includes(p)) fail(p.file, "not in nav.yaml, so no reader can reach it");
  for (const p of pages.values()) render(p, ctx);
  for (const l of ctx.links)
    if (l.anchor && !l.to.headings.some((h) => h.id === decode(l.anchor)))
      fail(l.from.file, `${l.href}: no heading #${l.anchor} in ${l.to.file}`);
  if (!errors.length && !o.check) await emit(ctx);
  return { pages: ctx.order, errors, urls: served(ctx) };
}

if (import.meta.main) {
  const o = { ...defaults(), check: process.argv.includes("--check") };
  const { pages, errors, urls } = await build(o);
  // --manifest=FILE lists every served URL, one per line, for docs-contract.sh.
  const manifest = process.argv.find((a) => a.startsWith("--manifest="))?.slice("--manifest=".length);
  if (manifest) await Bun.write(manifest, `${urls.join("\n")}\n`);
  if (errors.length) {
    console.error(`wiki: ${errors.length} problem${errors.length === 1 ? "" : "s"}\n${errors.map((e) => `  ${e}`).join("\n")}`);
    process.exit(1);
  }
  console.log(o.check ? `wiki: ${pages.length} pages OK` : `wiki: built ${pages.length} pages → ${o.out}`);
}
