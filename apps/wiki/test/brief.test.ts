import { beforeAll, expect, test } from 'bun:test';
import { renderBrief } from '../brief/build';
import { build, defaults, type Page } from '../build';

let page: Page;
let html: string;
const revision = 'a'.repeat(40);

beforeAll(async () => {
  const result = await build({ ...defaults(), check: true });
  expect(result.errors).toEqual([]);
  page = result.pages.find(
    (item) => item.file === 'reference/purchase-to-identity.md',
  )!;
  expect(page).toBeDefined();
  html = renderBrief(page, revision);
});

test('preserves every narrative paragraph and comparison cell', () => {
  const contents = [
    ...page.html.matchAll(/<(p|td|th)\b[^>]*>([\s\S]*?)<\/\1>/g),
  ];
  expect(contents.length).toBeGreaterThan(0);
  for (const [, , content] of contents) {
    const resolved = content
      .replaceAll(/(href|src)="(\/[^"]*)"/g, '$1="https://wiki.lolwtf.ca$2"')
      .replaceAll(
        'https://wiki.lolwtf.ca/assets/purchase-to-identity.svg',
        'purchase-to-identity.svg',
      );
    expect(html).toContain(resolved);
  }
  expect(html).not.toContain('<details class="stage"');
  expect(html).not.toContain('<script');
});

test('keeps canonical headings, evidence links and responsive table labels', () => {
  for (const heading of page.headings)
    expect(html).toContain(`id="${heading.id}"`);
  expect(html).toContain('https://wiki.lolwtf.ca/runbooks/provision-a-node/');
  expect(html).not.toMatch(/(?:href|src)="\//);
  expect(html).toContain('src="purchase-to-identity.svg"');
  expect(html).toContain(
    `/blob/${revision}/docs/reference/purchase-to-identity.md`,
  );
  expect(html).toContain('data-label="How fleetd uses it"');
});

test('refuses a misleading source revision or missing section structure', () => {
  expect(() => renderBrief(page, 'main')).toThrow('Invalid source revision');
  expect(() => renderBrief({ ...page, headings: [] }, revision)).toThrow(
    'section headings',
  );
});
