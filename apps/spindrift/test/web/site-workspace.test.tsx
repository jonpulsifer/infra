// The site workspace is read-only: what a kthx site serves, its releases and
// its usage. Static renders only, as the operator would read them.
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SiteView } from '../../src/commands/views.ts';
import { SiteDetail } from '../../src/web/views/sites/site.tsx';
import { SITE_VIEW } from '../fixtures/scenarios.ts';

const render = (site: SiteView = SITE_VIEW) =>
  renderToStaticMarkup(<SiteDetail site={site} onReload={() => undefined} />);

/** The rendered text, so a sentence split across spans is asserted whole. */
const words = (markup: string) =>
  markup
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ');

describe('the site workspace', () => {
  test('the header names the site and opens it in a new tab', () => {
    const markup = render();
    expect(words(markup)).toContain(' site ');
    expect(markup).toContain('>acme</span></h1>');
    expect(markup).toContain('href="https://acme.sites.example"');
    expect(markup).toContain('target="_blank"');
    expect(words(markup)).toContain('Open site');
  });

  test('the summary states status, release, owner, address and database', () => {
    const text = words(render());
    expect(text).toContain('Status Live');
    expect(text).toContain('release 7 · held');
    expect(text).toContain('Owner ada@example.org');
    expect(text).toContain('Address https://acme.sites.example');
    expect(text).toContain('Database ready');
  });

  test('an anonymous claim says so, and an agent sees no Owner row', () => {
    expect(words(render({ ...SITE_VIEW, owner: null }))).toContain(
      'Owner anonymous',
    );
    const { owner: _, ...agentView } = SITE_VIEW;
    expect(words(render(agentView))).not.toContain('Owner');
  });

  test('a database kthx has not made yet is repairing', () => {
    expect(words(render({ ...SITE_VIEW, provisioned: false }))).toContain(
      'Database repairing',
    );
  });

  test('the releases mark the serving one, and held only on it', () => {
    const markup = render();
    const text = words(markup);
    expect(text).toContain('7 serving held');
    expect(text.match(/serving/g)).toHaveLength(1);
    // The digest is cut to 12 characters, with the whole one in its title.
    expect(text).toContain('7a1c7a1c7a1c');
    expect(markup).toContain(`title="sha256:${'7a1c'.repeat(16)}"`);
    expect(text).toContain('180 KiB');
    expect(text).toContain('2.3 MiB');
  });

  test('a released but unheld site is not marked held', () => {
    const text = words(render({ ...SITE_VIEW, held: false }));
    expect(text).toContain('7 serving');
    expect(text).not.toContain('held');
  });

  test('a site with no upload says so and has no serving release', () => {
    const text = words(
      render({
        ...SITE_VIEW,
        release: null,
        held: false,
        releases: [],
        at: undefined,
        when: undefined,
      }),
    );
    expect(text).toContain('Status Never deployed');
    expect(text).toContain('Nothing uploaded yet.');
    expect(text).not.toContain('serving');
  });

  test('usage reads against each quota', () => {
    const text = words(render());
    expect(text).toContain('Database 1.2 MiB of 100 MiB');
    expect(text).toContain('Files 50 MiB of 1.0 GiB');
    expect(text).toContain('AI requests today 12 of 200');
    expect(text).toContain('AI tokens today 48,210 of 500,000');
  });

  test('it writes nothing: the only controls open the site and reload', () => {
    const markup = render();
    const buttons = markup.match(/<button[^>]*>.*?<\/button>/g) ?? [];
    const labels = buttons.map((button) => words(button).trim());
    expect(labels).toEqual(['Reload']);
    expect(words(markup)).not.toMatch(/\b(delete|roll ?back|claim|hold)\b/i);
  });

  test('no copy names the engine', () => {
    expect(render()).not.toMatch(/spindrift/i);
  });
});
