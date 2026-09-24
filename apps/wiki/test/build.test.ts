import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { page, site } from "./helpers";

const errorsFor = async (edits: Record<string, string | null>) => {
  const s = await site(edits, true);
  await s.cleanup();
  return s.errors;
};

describe("a valid tree", () => {
  let s: Awaited<ReturnType<typeof site>>;
  beforeAll(async () => {
    s = await site();
  });
  afterAll(() => s.cleanup());

  test("builds without errors, in nav order", () => {
    expect(s.errors).toEqual([]);
    expect(s.pages.map((p) => p.url).slice(0, 5)).toEqual([
      "/",
      "/apps/",
      "/apps/kthx/",
      "/apps/kthx/built-apps/",
      "/apps/mate/",
    ]);
  });

  test("headings get GitHub slugs, deduped, with hover anchors", async () => {
    const html = await s.read("apps/kthx/index.html");
    expect(html).toContain('<h2 id="before-you-start">Before you start<a class="hash" href="#before-you-start"');
    expect(html).toContain('<h2 id="install">');
    expect(html).toContain('<h2 id="install-1">');
    expect(html).toContain('<h3 id="ünïcode-héading--with-punctuation-yes">');
  });

  test("the rail lists h2 and h3 only", async () => {
    const html = await s.read("apps/kthx/index.html");
    const rail = html.slice(html.indexOf('<aside class="toc"'));
    expect(rail).toContain('<a href="#install-1">Install</a>');
    expect(rail).toContain('class="sub"');
    expect(html).toContain('<h4 id="deep-detail">');
    expect(rail).not.toContain("deep-detail");
  });

  test("alerts become callouts and plain quotes stay quotes", async () => {
    const html = await s.read("apps/kthx/index.html");
    expect(html).toContain('<div class="alert note" role="note"><p class="alert-title">note</p><p>Read the runbook first.</p>');
    expect(html).toMatch(/<div class="alert warning"[^>]*><p class="alert-title">warning<\/p><p>Multi-line<\/p>\s*<p>warning.<\/p>/);
    expect(html).toContain("<blockquote><p>A plain quote.</p>");
    expect(html).not.toContain("[!NOTE]");
  });

  test("raw HTML and angle brackets are escaped", async () => {
    const html = await s.read("apps/kthx/index.html");
    expect(html).toContain("<code>&lt;host&gt;.lolwtf.ca</code>");
    expect(html).toContain("raw &lt;b&gt;tags&lt;/b&gt; stay text &amp; escaped");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt; stays text");
    expect(html).not.toContain("<img src=x");
  });

  test("angle-bracket autolinks become links", async () => {
    const html = await s.read("apps/kthx/index.html");
    expect(html).toContain('<a href="https://example.com/docs" rel="noopener">https://example.com/docs</a>');
  });

  test("a linked image links where the link goes, without nesting anchors", async () => {
    const net = await s.read("platform/network/index.html");
    expect(net).toContain('<a href="/runbooks/deploy-a-nixos-host/"><img src="/assets/network.svg" alt="Deploy steps"');
    expect(net).not.toMatch(/<a [^>]*>(?:(?!<\/a>).)*<a /s);
  });

  test("links resolve to pages, anchors, assets and GitHub", async () => {
    const kthx = await s.read("apps/kthx/index.html");
    expect(kthx).toContain('<a href="/apps/kthx/built-apps/">built apps</a>');
    expect(kthx).toContain('<a href="/platform/network/#two-sites">the network</a>');
    const mate = await s.read("apps/mate/index.html");
    expect(mate).toContain('href="https://github.com/jonpulsifer/infra/blob/main/docs/agents/domain.md"');
    expect(mate).toContain('href="https://github.com/jonpulsifer/infra/blob/main/README.md"');
    const net = await s.read("platform/network/index.html");
    expect(net).toContain('<a class="fig" href="/assets/network.svg"><img src="/assets/network.svg" alt="Two sites and a tunnel"');
    expect(await s.read("assets/network.svg")).toContain("<svg");
  });

  test("ordered steps, task lists, tables and highlighted code render", async () => {
    const html = await s.read("runbooks/deploy-a-nixos-host/index.html");
    expect(html).toMatch(/<ol><li>Build the host\.<div class="code" data-lang="sh"><pre class="shiki/);
    expect(html).toContain('<input type="checkbox" disabled checked aria-label="done"> built');
    const net = await s.read("platform/network/index.html");
    expect(net).toContain('<th style="text-align:center">Uplink</th>');
  });

  test("cards list a section's entries with description and status", async () => {
    const home = await s.read("index.html");
    expect(home).toContain('<h2 id="apps"><a href="/apps/">Apps</a>');
    expect(home).toContain(
      '<a class="card" href="/apps/mate/"><span class="card-head"><span class="card-title">Rowbutt</span><span class="badge" data-status="parked">parked</span></span><span class="card-desc">A Discord bot that answers coding questions in a thread.</span></a>',
    );
    expect(home).toContain('<h2 id="platform">');
    const hosts = await s.read("hosts/index.html");
    expect(hosts).toContain('<h2 id="kubernetes-nodes">Kubernetes nodes');
    expect(hosts).toContain('href="/hosts/optiplex/"');
  });

  test("page chrome: breadcrumbs, badge, specs, backlinks, edit link, prev/next", async () => {
    const built = await s.read("apps/kthx/built-apps/index.html");
    expect(built).toContain(
      '<li><a href="/">Home</a></li><li><a href="/apps/">Apps</a></li><li><a href="/apps/kthx/">kthx</a></li><li><span aria-current="page">Built apps</span></li>',
    );
    expect(built).toContain('<a href="/apps/kthx/built-apps/" aria-current="page">Built apps</a>');
    const kthx = await s.read("apps/kthx/index.html");
    expect(kthx).toContain('<details class="backlinks"><summary>Linked from <span class="count">2</span>');
    expect(kthx).toContain("https://github.com/jonpulsifer/infra/edit/main/docs/apps/kthx.md");
    expect(kthx).toContain('<a class="prev" href="/apps/">');
    expect(kthx).toContain('<a class="next" href="/apps/kthx/built-apps/">');
    const host = await s.read("hosts/optiplex/index.html");
    expect(host).toContain('<tr><th scope="row">model</th><td>OptiPlex 3050 (micro)</td></tr>');
    expect(host).toContain('<span class="badge" data-status="live">live</span>');
  });

  test("pages.json carries the Markdown body untouched, in nav order", async () => {
    const pages = await s.json("pages.json");
    expect(pages[2]).toEqual({
      path: "apps/kthx",
      url: "/apps/kthx/",
      title: "kthx",
      description: "A deploy platform for built apps.",
      section: "Apps",
      status: "live",
      markdown: expect.stringContaining("```sh\nnix run .#<hostname> -- switch\ncurl -s localhost/mcp | jq '.result.tools | length'\n```"),
    });
    expect(pages[0]).toMatchObject({ path: "", url: "/", section: null, status: null });
    expect(pages.map((p: { path: string }) => p.path)).not.toContain("agents/domain");
  });

  test("search.json indexes titles, descriptions, headings and full text", async () => {
    const index = await s.json("search.json");
    const kthx = index.find((p: { u: string }) => p.u === "/apps/kthx/");
    expect(kthx.d).toBe("A deploy platform for built apps.");
    expect(kthx.h).toContainEqual(["Install", "install-1"]);
    expect(kthx.x).toContain("nix run .#<hostname> -- switch");
    expect(kthx.x).not.toContain("#<a");
  });

  test("404, graph and client assets are written", async () => {
    expect(await s.read("404.html")).toContain("Not found");
    const graph = await s.json("graph.json");
    expect(graph.links.length).toBeGreaterThan(0);
    expect(graph.links.flat().every((i: number) => i >= 0 && i < graph.nodes.length)).toBe(true);
    expect(await s.read("client.js")).toContain("search.json");
  });

  test("urls lists every page, anchor and asset the site serves", () => {
    expect(s.urls).toContain("/apps/kthx/");
    expect(s.urls).toContain("/apps/kthx/#before-you-start");
    expect(s.urls).toContain("/");
    expect(s.urls).toContain("/assets/network.svg");
    expect(s.urls).toContain("/pages.json");
    expect(s.urls).not.toContain("/assets/network.d2");
    expect(s.urls.some((u) => u.startsWith("/agents/"))).toBe(false);
  });
});

describe("titles and descriptions are escaped everywhere", () => {
  const title = 'Rowbutt <b>"&';
  const description = "A <i>bot</i> & 'more'";
  let s: Awaited<ReturnType<typeof site>>;
  beforeAll(async () => {
    s = await site({
      "apps/mate.md": page(`title: '${title.replace(/'/g, "''")}'\ndescription: "${description}"\nstatus: parked`, "See [kthx](kthx.md).\n"),
    });
  });
  afterAll(() => s.cleanup());

  test("in the page, the sidebar, cards and backlinks", async () => {
    expect(s.errors).toEqual([]);
    const t = "Rowbutt &lt;b&gt;&quot;&amp;";
    const d = "A &lt;i&gt;bot&lt;/i&gt; &amp; &#39;more&#39;";
    const mate = await s.read("apps/mate/index.html");
    expect(mate).toContain(`<title>${t} · infra wiki</title>`);
    expect(mate).toContain(`<meta name="description" content="${d}">`);
    expect(mate).toContain(`<h1>${t}</h1><p class="lead">${d}</p>`);
    expect(mate).toContain(`<a href="/apps/mate/" aria-current="page">${t}</a>`);
    const home = await s.read("index.html");
    expect(home).toContain(`<span class="card-title">${t}</span>`);
    expect(home).toContain(`<span class="card-desc">${d}</span>`);
    const kthx = await s.read("apps/kthx/index.html");
    expect(kthx).toContain(`<li><a href="/apps/mate/">${t}</a><span>${d}</span></li>`);
    for (const html of [mate, home, kthx]) expect(html).not.toContain("<b>");
  });

  test("raw in search.json, which the client renders as text", async () => {
    const index = await s.json("search.json");
    expect(index.find((p: { u: string }) => p.u === "/apps/mate/")).toMatchObject({ t: title, d: description });
  });
});

describe("validation", () => {
  test("frontmatter needs a title and a description", async () => {
    const errors = await errorsFor({ "apps/mate.md": page("title: Rowbutt") });
    expect(errors).toEqual(["docs/apps/mate.md: frontmatter needs a description"]);
    expect(await errorsFor({ "apps/mate.md": "Just text.\n" })).toContainEqual(
      expect.stringContaining("docs/apps/mate.md: no frontmatter"),
    );
  });

  test("frontmatter keys, status and cards are checked", async () => {
    const errors = await errorsFor({
      "apps/mate.md": page("title: Rowbutt\ndescription: Bot.\nstatus: offline\nicon: x\ncards: nope"),
    });
    expect(errors).toContainEqual(expect.stringContaining('unknown frontmatter key "icon"'));
    expect(errors).toContainEqual(expect.stringContaining('status "offline" is not one of'));
    expect(errors).toContainEqual(expect.stringContaining('cards: no nav section "nope"'));
  });

  test("an orphan page fails", async () => {
    const errors = await errorsFor({ "apps/lonely.md": page("title: Lonely\ndescription: Nobody links here.") });
    expect(errors).toEqual(["docs/apps/lonely.md: not in nav.yaml, so no reader can reach it"]);
  });

  test("a nav entry with no file fails, and so does a duplicate", async () => {
    const errors = await errorsFor({ "apps/mate.md": null, "apps/kthx.md": page("title: kthx\ndescription: x.") });
    expect(errors).toContain("docs/nav.yaml: apps/mate.md has no file");
    const nav = (await Bun.file(`${import.meta.dir}/fixtures/docs/nav.yaml`).text()).replace(
      "      - apps/mate.md",
      "      - apps/mate.md\n      - apps/mate.md",
    );
    expect(await errorsFor({ "nav.yaml": nav })).toEqual(["docs/nav.yaml: apps/mate.md is listed twice"]);
  });

  test("broken links, anchors and images fail", async () => {
    const errors = await errorsFor({
      "apps/mate.md": page(
        "title: Rowbutt\ndescription: Bot.",
        "[a](nope.md) [b](kthx.md#missing) [c](#here) [d](/apps/kthx/) ![e](../assets/gone.svg) [f](../../../outside.md)\n",
      ),
    });
    expect(errors).toEqual([
      "docs/apps/mate.md: broken link nope.md",
      "docs/apps/mate.md: /apps/kthx/: link with a relative path, not a site path",
      "docs/apps/mate.md: image ../assets/gone.svg is not in docs/assets",
      "docs/apps/mate.md: broken link ../../../outside.md",
      "docs/apps/mate.md: kthx.md#missing: no heading #missing in apps/kthx.md",
      "docs/apps/mate.md: #here: no heading #here in apps/mate.md",
    ]);
  });

  test("links take http(s) or mailto, images http(s)", async () => {
    const errors = await errorsFor({
      "apps/mate.md": page(
        "title: Rowbutt\ndescription: Bot.",
        "[a](javascript:alert(1)) ![b](javascript:alert(2)) ![c](mailto:x@y.z) [d](mailto:x@y.z) [e](https://x.y)\n",
      ),
    });
    expect(errors).toEqual([
      "docs/apps/mate.md: javascript:alert(1): links take http(s) or mailto URLs or relative paths",
      "docs/apps/mate.md: javascript:alert(2): images take http(s) URLs or relative paths",
      "docs/apps/mate.md: mailto:x@y.z: images take http(s) URLs or relative paths",
    ]);
  });

  test("Logseq [[links]] fail outside code", async () => {
    const errors = await errorsFor({
      "apps/mate.md": page("title: Rowbutt\ndescription: Bot.", "See [[Runbooks/Deploy]]. Code `[[ -f x ]]` is fine.\n"),
    });
    expect(errors).toEqual(["docs/apps/mate.md: [[Page]] is Logseq syntax; link the page by its relative .md path"]);
  });

  test("a section index is a path, so no page hides under it", async () => {
    const nav = (await Bun.file(`${import.meta.dir}/fixtures/docs/nav.yaml`).text()).replace(
      "    index: platform/index.md",
      "    index: {path: platform/index.md, children: [platform/extra.md]}",
    );
    const errors = await errorsFor({ "nav.yaml": nav, "platform/extra.md": page("title: Extra\ndescription: x.") });
    expect(errors).toContain("docs/nav.yaml: Platform index must be a path; put children under an item instead");
    expect(errors).toContain("docs/platform/extra.md: not in nav.yaml, so no reader can reach it");
  });

  test("an H1 in the body fails, ATX or setext", async () => {
    const atx = await errorsFor({ "apps/mate.md": page("title: Rowbutt\ndescription: Bot.", "# Rowbutt\n") });
    expect(atx).toEqual(['docs/apps/mate.md: H1 "Rowbutt" in the body; the title is the H1, so start sections at ##']);
    const setext = await errorsFor({ "apps/mate.md": page("title: Rowbutt\ndescription: Bot.", "Rowbutt\n===\n") });
    expect(setext).toHaveLength(1);
  });

  test("file names must be lowercase kebab-case", async () => {
    const nav = (await Bun.file(`${import.meta.dir}/fixtures/docs/nav.yaml`).text()).replace(
      "apps/mate.md",
      "apps/Mate_Bot.md",
    );
    const errors = await errorsFor({
      "nav.yaml": nav,
      "apps/mate.md": null,
      "apps/Mate_Bot.md": page("title: Rowbutt\ndescription: Bot."),
    });
    expect(errors).toEqual(["docs/apps/Mate_Bot.md: file names are lowercase kebab-case"]);
  });

  test("check mode validates without writing", async () => {
    const s = await site({}, true);
    expect(s.errors).toEqual([]);
    expect(await s.read("index.html").catch(() => "none")).toBe("none");
    await s.cleanup();
  });
});
