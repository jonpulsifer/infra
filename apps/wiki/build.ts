/**
 * wiki — a tiny static site generator for the docs/ Logseq graph.
 *
 * Reads docs/pages/*.md + docs/journals/*.md (Logseq outline markdown:
 * `- ` blocks, tab nesting, `key:: value` page properties, [[wikilinks]])
 * and renders a static site to dist/: pages, backlinks, namespace listings,
 * tag pages, a client-side search index, and a force-directed graph view.
 */
import { codeToHtml } from "shiki";
import { readdir, mkdir, rm, cp } from "node:fs/promises";
import { join, dirname } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const DOCS = join(ROOT, "docs");
const OUT = join(import.meta.dir, "dist");
const SITE = "wiki.lolwtf.ca";
const REPO = "https://github.com/jonpulsifer/infra";

// ── model ────────────────────────────────────────────────────────────────────

interface Block {
  depth: number;
  lines: string[];
  children: Block[];
}

interface Page {
  name: string; // "ADR/0001 GitOps apply model"
  file: string; // path relative to repo root, for edit links
  kind: "page" | "journal";
  props: Record<string, string>;
  blocks: Block[];
  url: string; // "/adr/0001-gitops-apply-model/"
}

interface Ref {
  page: Page;
  html: string;
}

const pages = new Map<string, Page>(); // lowercased name -> page
const backlinks = new Map<string, Ref[]>(); // lowercased target name -> refs
const tagged = new Map<string, Page[]>(); // tag -> pages

// ── parsing ──────────────────────────────────────────────────────────────────

function parse(src: string): { props: Record<string, string>; blocks: Block[] } {
  const lines = src.split("\n");
  const props: Record<string, string> = {};
  let i = 0;
  while (i < lines.length && /^[A-Za-z][\w-]*:: /.test(lines[i])) {
    const at = lines[i].indexOf(":: ");
    props[lines[i].slice(0, at).toLowerCase()] = lines[i].slice(at + 3).trim();
    i++;
  }
  const blocks: Block[] = [];
  const stack: Block[] = [];
  for (; i < lines.length; i++) {
    const m = lines[i].match(/^(\t*)- (.*)$/);
    if (m) {
      const b: Block = { depth: m[1].length, lines: [m[2]], children: [] };
      while (stack.length && stack[stack.length - 1].depth >= b.depth) stack.pop();
      (stack.length ? stack[stack.length - 1].children : blocks).push(b);
      stack.push(b);
    } else if (stack.length && lines[i].trim() !== "") {
      // continuation line: strip the block's tab indent + two-space alignment
      stack[stack.length - 1].lines.push(lines[i].replace(/^\t*(?: {2})?/, ""));
    }
  }
  return { props, blocks };
}

function slug(name: string): string {
  return name
    .split("/")
    .map((s) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, ""),
    )
    .join("/");
}

function pageUrl(name: string, kind: Page["kind"]): string {
  if (kind === "journal") return `/journals/${slug(name)}/`;
  if (name.toLowerCase() === "home") return "/";
  return `/${slug(name)}/`;
}

// ── inline rendering ─────────────────────────────────────────────────────────

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function wikilink(name: string, current: Page): string {
  const target = pages.get(name.toLowerCase());
  if (target) return `<a class="wl" href="${target.url}">${esc(target.name)}</a>`;
  return `<span class="wl broken" title="no such page (yet)">${esc(name)}</span>`;
}

function inline(s: string, page: Page, refs?: Set<string>): string {
  s = esc(s);
  const codes: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, `<img alt="$1" src="$2" loading="lazy">`);
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, `<a href="$2" rel="noopener">$1</a>`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, `<a href="$2">$1</a>`);
  s = s.replace(/\[\[([^\]]+)\]\]/g, (_, n) => {
    refs?.add(n.toLowerCase());
    return wikilink(n, page);
  });
  s = s.replace(
    /(^|[\s(])#([A-Za-z][\w/-]*)/g,
    (_, sp, t) => `${sp}<a class="tag" href="/tags/${slug(t)}/">#${t}</a>`,
  );
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[\s(>])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
  s = s.replace(/==([^=]+)==/g, "<mark>$1</mark>");
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
  return s;
}

// ── block rendering ──────────────────────────────────────────────────────────

async function highlight(code: string, lang: string): Promise<string> {
  const opts = {
    themes: { light: "catppuccin-latte", dark: "tokyo-night" },
    defaultColor: false,
  } as const;
  try {
    return await codeToHtml(code, { lang: lang || "text", ...opts });
  } catch {
    return await codeToHtml(code, { lang: "text", ...opts });
  }
}

async function renderBlockContent(
  b: Block,
  page: Page,
  refs: Set<string>,
): Promise<{ html: string; heading: boolean }> {
  const text = b.lines.join("\n").trim();

  const fence = text.match(/^```(\S*)\n?([\s\S]*?)\n?```$/);
  if (fence) return { html: await highlight(fence[2], fence[1]), heading: false };

  const rows = text.split("\n");
  if (rows.length > 1 && rows.every((r) => r.trim().startsWith("|"))) {
    const cells = (r: string) =>
      r
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => inline(c.trim(), page, refs));
    const head = cells(rows[0]);
    const body = rows.slice(2).map(cells);
    return {
      html:
        `<div class="tablewrap"><table><thead><tr>` +
        head.map((h) => `<th>${h}</th>`).join("") +
        `</tr></thead><tbody>` +
        body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("") +
        `</tbody></table></div>`,
      heading: false,
    };
  }

  const h = text.match(/^(#{1,4}) (.*)$/s);
  if (h) {
    const level = h[1].length + 1; // # -> h2
    return { html: `<h${level}>${inline(h[2], page, refs)}</h${level}>`, heading: true };
  }

  const html = text
    .split("\n")
    .map((l) => inline(l, page, refs))
    .join("<br>");
  return { html: `<p>${html}</p>`, heading: false };
}

async function renderBlocks(blocks: Block[], page: Page, refs: Set<string>): Promise<string> {
  let out = `<ul class="outline">`;
  for (const b of blocks) {
    const { html, heading } = await renderBlockContent(b, page, refs);
    const kids = b.children.length ? await renderBlocks(b.children, page, refs) : "";
    out += `<li class="block${heading ? " hblock" : ""}"><div class="bc">${html}</div>${kids}</li>`;
  }
  return out + `</ul>`;
}

// collect backlink refs: flat render of a single block (without children) for the refs panel
async function blockSnippet(b: Block, page: Page): Promise<string> {
  const { html } = await renderBlockContent(b, page, new Set());
  return html;
}

// ── chrome ───────────────────────────────────────────────────────────────────

const NAV_ORDER = ["Home", "Architecture", "Runbooks", "Fleet"];

function nav(current: Page | null): string {
  const item = (name: string) => {
    const p = pages.get(name.toLowerCase());
    if (!p) return "";
    const here = current && p.name === current.name ? ` aria-current="page"` : "";
    const kids = [...pages.values()]
      .filter((c) => c.name.startsWith(name + "/") && !c.name.endsWith("/Template"))
      .sort((a, b) => a.name.localeCompare(b.name));
    return (
      `<li><a href="${p.url}"${here}>${esc(name)}</a>` +
      (kids.length
        ? `<ul>` +
          kids
            .map((c) => {
              const cur = current && c.name === current.name ? ` aria-current="page"` : "";
              return `<li><a href="${c.url}"${cur}>${esc(c.name.slice(name.length + 1))}</a></li>`;
            })
            .join("") +
          `</ul>`
        : "") +
      `</li>`
    );
  };
  return (
    `<ul class="nav">` +
    NAV_ORDER.map(item).join("") +
    `<li><a href="/graph/"${current?.name === "__graph" ? ` aria-current="page"` : ""}>Graph</a></li>` +
    `<li><a href="/journals/"${current?.kind === "journal" ? ` aria-current="page"` : ""}>Journals</a></li>` +
    `</ul>`
  );
}

function chip(k: string, v: string, page: Page): string {
  if (k === "tags")
    return v
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => `<a class="tag" href="/tags/${slug(t)}/">#${esc(t)}</a>`)
      .join(" ");
  if (k === "status") return `<span class="chip status-${esc(v.split(" ")[0])}">${esc(v)}</span>`;
  return `<span class="chip"><b>${esc(k)}</b> ${inline(v, page)}</span>`;
}

function layout(title: string, current: Page | null, body: string, desc = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · infra wiki</title>
<meta name="description" content="${esc(desc || `${title} — jonpulsifer/infra wiki`)}">
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🛰️</text></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/style.css">
<script>document.documentElement.classList.toggle("dark",(localStorage.theme??"dark")==="dark")</script>
</head>
<body>
<div class="layout">
<input type="checkbox" id="menu" hidden>
<aside class="sidebar">
  <a class="logo" href="/"><span class="logo-mark">🛰️</span> <span class="logo-text">infra<b>wiki</b></span></a>
  <button class="searchbtn" data-search>Search… <kbd>⌘K</kbd></button>
  ${nav(current)}
  <div class="side-foot">
    <button class="themebtn" data-theme-toggle title="toggle theme">◐</button>
    <a href="${REPO}" rel="noopener">GitHub</a>
  </div>
</aside>
<main>
<label for="menu" class="hamburger" aria-label="menu">☰</label>
${body}
<footer class="foot">Built from <a href="${REPO}/tree/main/docs" rel="noopener">docs/</a> with <a href="${REPO}/tree/main/apps/wiki" rel="noopener">bun + ~400 lines of TypeScript</a> · deployed on Cloudflare Pages</footer>
</main>
</div>
<div class="search-modal" hidden><div class="search-box"><input type="search" placeholder="Search the wiki…" aria-label="search"><ul class="search-results"></ul></div></div>
<script src="/client.js" defer></script>
</body>
</html>`;
}

function breadcrumbs(p: Page): string {
  const parts = p.name.split("/");
  if (parts.length === 1 && p.kind === "page") return "";
  let acc = "";
  const crumbs = parts.slice(0, -1).map((part) => {
    acc = acc ? `${acc}/${part}` : part;
    const t = pages.get(acc.toLowerCase());
    return t ? `<a href="${t.url}">${esc(part)}</a>` : `<span>${esc(part)}</span>`;
  });
  if (p.kind === "journal") crumbs.unshift(`<a href="/journals/">Journals</a>`);
  return crumbs.length ? `<nav class="crumbs">${crumbs.join(`<span class="sep">/</span>`)}</nav>` : "";
}

// ── build ────────────────────────────────────────────────────────────────────

async function loadPages() {
  for (const kind of ["pages", "journals"] as const) {
    const dir = join(DOCS, kind);
    const files = ((await readdir(dir).catch(() => [])) as string[]).filter((f) => f.endsWith(".md"));
    for (const f of files) {
      const raw = await Bun.file(join(dir, f)).text();
      const { props, blocks } = parse(raw);
      const name =
        kind === "journals"
          ? f.replace(/\.md$/, "").replace(/_/g, "-")
          : f.replace(/\.md$/, "").replace(/___/g, "/");
      const page: Page = {
        name,
        file: `docs/${kind}/${f}`,
        kind: kind === "journals" ? "journal" : "page",
        props,
        blocks,
        url: pageUrl(name, kind === "journals" ? "journal" : "page"),
      };
      pages.set(name.toLowerCase(), page);
    }
  }
}

function plainText(blocks: Block[], acc: string[] = []): string[] {
  for (const b of blocks) {
    acc.push(
      b.lines
        .join(" ")
        .replace(/```\S*/g, "")
        .replace(/\[\[([^\]]+)\]\]/g, "$1")
        .replace(/[*`#|]+/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    );
    plainText(b.children, acc);
  }
  return acc;
}

async function collectRefs() {
  // walk every block of every page; record outgoing wikilinks with a snippet
  for (const page of pages.values()) {
    if (page.name.toLowerCase() === "contents") continue;
    const walk = async (bs: Block[]) => {
      for (const b of bs) {
        const refs = new Set<string>();
        const text = b.lines.join("\n");
        for (const m of text.matchAll(/\[\[([^\]]+)\]\]/g)) refs.add(m[1].toLowerCase());
        if (refs.size) {
          const html = await blockSnippet(b, page);
          for (const r of refs) {
            if (!backlinks.has(r)) backlinks.set(r, []);
            backlinks.get(r)!.push({ page, html });
          }
        }
        await walk(b.children);
      }
    };
    await walk(page.blocks);
  }
  for (const page of pages.values()) {
    for (const t of (page.props["tags"] ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      if (!tagged.has(t)) tagged.set(t, []);
      tagged.get(t)!.push(page);
    }
  }
}

async function emit(path: string, html: string) {
  const file = join(OUT, path.replace(/^\//, ""), "index.html");
  await mkdir(dirname(file), { recursive: true });
  await Bun.write(file, html);
}

async function renderPage(p: Page): Promise<string> {
  const refs = new Set<string>();
  const content = await renderBlocks(p.blocks, p, refs);
  const icon = p.props["icon"] ? `<span class="picon">${p.props["icon"]}</span>` : "";
  const meta = Object.entries(p.props)
    .filter(([k]) => k !== "icon")
    .map(([k, v]) => chip(k, v, p))
    .join(" ");
  const kids = [...pages.values()]
    .filter((c) => c.name.startsWith(p.name + "/"))
    .sort((a, b) => a.name.localeCompare(b.name));
  const bl = (backlinks.get(p.name.toLowerCase()) ?? []).filter((r) => r.page.name !== p.name);
  const title = p.kind === "journal" ? p.name : p.name.split("/").pop()!;

  return layout(
    p.name,
    p,
    `${breadcrumbs(p)}
<article>
<h1 class="ptitle">${icon}${esc(title)}</h1>
${meta ? `<div class="props">${meta}</div>` : ""}
${content}
${
  kids.length
    ? `<section class="panel"><h2>Sub-pages</h2><ul class="reflist">` +
      kids.map((k) => `<li><a class="wl" href="${k.url}">${esc(k.name)}</a></li>`).join("") +
      `</ul></section>`
    : ""
}
${
  bl.length
    ? `<section class="panel"><h2>Linked references <span class="count">${bl.length}</span></h2>` +
      bl
        .map(
          (r) =>
            `<div class="ref"><a class="ref-src" href="${r.page.url}">${esc(r.page.name)}</a><div class="ref-body">${r.html}</div></div>`,
        )
        .join("") +
      `</section>`
    : ""
}
<p class="editlink"><a href="${REPO}/edit/main/${encodeURI(p.file)}" rel="noopener">Edit this page on GitHub</a></p>
</article>`,
    plainText(p.blocks).join(" ").slice(0, 155),
  );
}

async function build() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  await loadPages();
  await collectRefs();

  // pages
  for (const p of pages.values()) {
    if (p.name.toLowerCase() === "contents") continue;
    await emit(p.url, await renderPage(p));
  }

  // journals index
  const journals = [...pages.values()]
    .filter((p) => p.kind === "journal")
    .sort((a, b) => b.name.localeCompare(a.name));
  let jbody = `<article><h1 class="ptitle">Journals</h1>`;
  for (const j of journals) {
    jbody += `<section class="journal"><h2><a class="wl" href="${j.url}">${esc(j.name)}</a></h2>${await renderBlocks(j.blocks, j, new Set())}</section>`;
  }
  await emit("/journals/", layout("Journals", null, jbody + `</article>`));

  // tag pages
  for (const [tag, tps] of tagged) {
    await emit(
      `/tags/${slug(tag)}/`,
      layout(
        `#${tag}`,
        null,
        `<article><h1 class="ptitle"><span class="picon">#</span>${esc(tag)}</h1><ul class="reflist">` +
          tps
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((p) => `<li><a class="wl" href="${p.url}">${esc(p.name)}</a></li>`)
            .join("") +
          `</ul></article>`,
      ),
    );
  }

  // graph page + data
  const ids = [...pages.values()].filter((p) => p.name.toLowerCase() !== "contents");
  const index = new Map(ids.map((p, i) => [p.name.toLowerCase(), i]));
  const links: [number, number][] = [];
  for (const [target, refs] of backlinks) {
    const t = index.get(target);
    if (t === undefined) continue;
    for (const r of refs) {
      const s = index.get(r.page.name.toLowerCase());
      if (s !== undefined && s !== t) links.push([s, t]);
    }
  }
  const deg = new Array(ids.length).fill(1);
  for (const [s, t] of links) (deg[s] += 1), (deg[t] += 1);
  await Bun.write(
    join(OUT, "graph.json"),
    JSON.stringify({
      nodes: ids.map((p, i) => ({ t: p.name, u: p.url, d: deg[i] })),
      links,
    }),
  );
  await emit(
    "/graph/",
    layout(
      "Graph",
      { name: "__graph" } as Page,
      `<article class="grapharticle"><h1 class="ptitle">Graph</h1><p class="dim">Every page, every link. Drag to pan, scroll to zoom, click to visit.</p><canvas id="graph"></canvas></article>`,
    ),
  );

  // search index
  await Bun.write(
    join(OUT, "search.json"),
    JSON.stringify(
      ids.map((p) => ({ t: p.name, u: p.url, x: plainText(p.blocks).join(" ").slice(0, 2000) })),
    ),
  );

  // 404
  await Bun.write(
    join(OUT, "404.html"),
    layout(
      "404",
      null,
      `<article><h1 class="ptitle">404</h1><p>No such page. It would render as a <span class="wl broken">broken link</span> — maybe it's waiting to be written. <a class="wl" href="/">Go home</a>.</p></article>`,
    ),
  );

  // static assets
  await cp(join(import.meta.dir, "assets", "style.css"), join(OUT, "style.css"));
  await cp(join(import.meta.dir, "assets", "client.js"), join(OUT, "client.js"));

  console.log(`built ${ids.length} pages, ${links.length} graph edges → ${OUT}`);
}

await build();
