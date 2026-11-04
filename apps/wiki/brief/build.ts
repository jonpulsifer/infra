import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { build, defaults, type Page } from '../build';

const canonical = 'https://wiki.lolwtf.ca';
const source = 'reference/purchase-to-identity.md';
const escapeHtml = (value: string) => Bun.escapeHTML(value);

export function renderBrief(page: Page, revision: string): string {
  if (!/^[a-f0-9]{40}$/.test(revision))
    throw new Error('Invalid source revision');
  const headings = page.headings.filter((heading) => heading.level === 2);
  if (!headings.length) throw new Error('The brief needs section headings');
  let body = page.html.replaceAll(
    /(href|src)="(\/[^"]*)"/g,
    `$1="${canonical}$2"`,
  );
  body = body.replaceAll(
    `${canonical}/assets/purchase-to-identity.svg`,
    'purchase-to-identity.svg',
  );
  body = body.replace(
    /<p>(<a[^>]*>)?<img [^>]*purchase-to-identity\.svg[^>]*>(<\/a>)?<\/p>/,
    (diagram) =>
      `<details class="diagram"><summary>Open the architecture diagram <span aria-hidden="true">↗</span></summary>${diagram}</details>`,
  );
  body = body.replaceAll(
    /<div class="table"><table>([\s\S]*?)<\/table><\/div>/g,
    (_, tableBody: string) => {
      const labels = [...tableBody.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(
        (cell) => cell[1].replace(/<[^>]+>/g, ''),
      );
      const responsive = tableBody.replace(
        /<tbody>([\s\S]*?)<\/tbody>/,
        (_, rowsHtml: string) =>
          `<tbody>${rowsHtml.replaceAll(
            /<tr>([\s\S]*?)<\/tr>/g,
            (_, row: string) => {
              let column = 0;
              return `<tr>${row.replaceAll(/<td([^>]*)>/g, (_, attributes: string) => `<td${attributes} data-label="${escapeHtml(labels[column++] ?? '')}">`)}</tr>`;
            },
          )}</tbody>`,
      );
      return `<div class="table"><table>${responsive}</table></div>`;
    },
  );
  let sectionIndex = 0;
  body = body.replaceAll(
    /<h2 id="([^"]+)">([\s\S]*?)<\/h2>/g,
    (_, id: string, title: string) =>
      `${sectionIndex ? '</section>' : '</div>'}<section aria-labelledby="${id}"><div class="section-label">${String(++sectionIndex).padStart(2, '0')} / FIELD NOTES</div><h2 id="${id}">${title}</h2>`,
  );
  const navigation = headings
    .map(
      (heading, index) =>
        `<a href="#${escapeHtml(heading.id)}"><span>${String(index + 1).padStart(2, '0')}</span>${escapeHtml(heading.text)}</a>`,
    )
    .join('\n');
  const sourceUrl = `https://github.com/jonpulsifer/infra/blob/${revision}/docs/${source}`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(page.title)} · Folly</title>
  <meta name="description" content="${escapeHtml(page.description)}">
  <meta name="color-scheme" content="light">
  <link rel="canonical" href="${canonical}${page.url}">
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  <header class="masthead"><a class="wordmark" href="#top"><span class="mark" aria-hidden="true">f.</span> FOLLY <span class="edition">/ SYSTEMS NOTES</span></a><a class="wiki-link" href="${canonical}${page.url}">Read the wiki <span aria-hidden="true">↗</span></a></header>
  <main id="main">
    <div class="hero" id="top"><div class="eyebrow">SECURITY ENGINEERING / ARCHITECTURE BRIEF</div><h1>From purchase<br>to <em>workload identity.</em></h1><div class="hero-bottom"><p>A machine arrives.<br>What makes it trusted enough to join?</p><a class="start" href="#${escapeHtml(headings[0]?.id ?? '')}">Follow the machine <span aria-hidden="true">↓</span></a></div></div>
    <div class="scope"><span class="scope-label">SCOPE OF ASSURANCE</span><span>How inventory becomes an installation, and what we gain or lose by simplifying it.</span><a href="${sourceUrl}" title="Canonical content revision">SOURCE ${revision.slice(0, 8)} ↗</a></div>
    <div class="layout"><aside><nav class="brief-nav" aria-label="In this brief"><p class="nav-label">IN THIS BRIEF</p>${navigation}</nav><div class="margin-note">NetBox records the machine and the requested action. fleetd turns that record into an authorized job. Tinkerbell runs the job.</div></aside><article><div class="introduction">${body}</section></article></div>
  </main>
  <footer class="site-footer"><a class="wordmark" href="#top">FOLLY / SYSTEMS NOTES</a><p>Canonical content from the <a href="${canonical}${page.url}">infrastructure wiki</a>.<br><a href="${sourceUrl}">Inspect the source revision</a> · <a href="${canonical}/reference/folly-design/">Detailed trust design</a></p><span>END OF BRIEF <a href="#top" aria-label="Back to top">↑</a></span></footer>
</body>
</html>`;
}

if (import.meta.main) {
  const options = defaults();
  const clean = Bun.spawnSync(
    [
      'git',
      'diff',
      '--quiet',
      'HEAD',
      '--',
      `docs/${source}`,
      'docs/assets/purchase-to-identity.svg',
    ],
    { cwd: options.repo },
  );
  if (clean.exitCode)
    throw new Error(
      'Commit the canonical content before building a revision-linked brief',
    );
  const result = await build({ ...options, check: true });
  if (result.errors.length) throw new Error(result.errors.join('\n'));
  const page = result.pages.find((page) => page.file === source);
  if (!page) throw new Error(`Missing canonical page: ${source}`);
  const revision = Bun.spawnSync(
    [
      'git',
      'log',
      '-1',
      '--format=%H',
      '--',
      `docs/${source}`,
      'docs/assets/purchase-to-identity.svg',
    ],
    { cwd: options.repo },
  );
  if (revision.exitCode)
    throw new Error('Cannot identify the content revision');
  const out = join(import.meta.dir, 'dist');
  await mkdir(out, { recursive: true });
  await Bun.write(
    join(out, 'index.html'),
    renderBrief(page, revision.stdout.toString().trim()),
  );
  await Bun.write(
    join(out, 'style.css'),
    Bun.file(join(import.meta.dir, 'style.css')),
  );
  await Bun.write(
    join(out, 'purchase-to-identity.svg'),
    Bun.file(join(options.docs, 'assets', 'purchase-to-identity.svg')),
  );
  console.log(`brief: built ${page.title} → ${out}`);
}
