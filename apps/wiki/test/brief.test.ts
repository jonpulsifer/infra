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

test('preserves every lifecycle cell in accessible disclosure elements', () => {
  const lifecycle = page.html.match(/<tbody>([\s\S]*?)<\/tbody>/)![1];
  const cells = [...lifecycle.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)];
  expect(cells.length).toBeGreaterThan(0);
  expect([...html.matchAll(/<details class="stage"/g)]).toHaveLength(
    cells.length / 3,
  );
  for (const cell of cells) expect(html).toContain(cell[1]);
  expect(html).not.toContain('<script');
});

test('keeps canonical headings, caveats and wiki links', () => {
  for (const heading of page.headings)
    expect(html).toContain(`id="${heading.id}"`);
  expect(html).toContain(
    'does not establish complete supply-chain integrity or continuous runtime integrity',
  );
  expect(html).toContain('Power loss in that gap requires a new provision');
  expect(html).toContain('https://wiki.lolwtf.ca/runbooks/provision-a-node/');
  expect(html).not.toMatch(/(?:href|src)="\//);
  expect(html).toContain('src="purchase-to-identity.svg"');
  expect(html).toContain(
    `/blob/${revision}/docs/reference/purchase-to-identity.md`,
  );
  expect(html).toContain('data-label="Accepted cost"');
});

test('refuses a misleading source revision or missing lifecycle structure', () => {
  expect(() => renderBrief(page, 'main')).toThrow('Invalid source revision');
  expect(() =>
    renderBrief({ ...page, html: '<p>No stages</p>' }, revision),
  ).toThrow('lifecycle table');
});
