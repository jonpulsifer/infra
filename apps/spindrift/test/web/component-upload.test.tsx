/**
 * Where the Component upload control is offered, and where it is not.
 *
 * Rendered to static markup for the reason `views.test.tsx` gives: every rule
 * here is a statement about what appears in a given state, not about
 * interaction. The three states are the ones `uploadArchive`'s input decides —
 * it resolves on `(componentId, targetId)`, so a Component with no Target has
 * nothing to aim at and a Component with two has to be asked which.
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentView } from '../../src/web/model.ts';
import { ComponentUploadButton } from '../../src/web/views/apps/component-upload.tsx';

const COMPONENT: ComponentView = {
  id: 'component-deck',
  name: 'deck',
  kind: 'website',
  phase: 'LIVE',
  artifact: 'files·sha256:1d7ea',
  reach: 'public',
  auth: 'none',
};

const render = (component: ComponentView, archiveSourced = true): string =>
  renderToStaticMarkup(
    <ComponentUploadButton
      component={component}
      archiveSourced={archiveSourced}
      onStage={async () => ({
        digest: 'sha256:1133c9af',
        location: 'gs://depot/deck.tar.gz',
        filename: 'deck.tar.gz',
        size: 13718,
      })}
      onSubmit={async () => ({ ok: true })}
    />,
  );

describe('the Component upload control', () => {
  test('is absent where nothing places the Component', () => {
    // `uploadArchive` needs a targetId to resolve an artifact shape against,
    // and a first placement is `deployApp`'s act rather than this one's — so
    // the control is absent rather than present and refusing.
    expect(render(COMPONENT)).toBe('');
    expect(render({ ...COMPONENT, serving: [] })).toBe('');
  });

  test('is offered on a Component that is placed', () => {
    const markup = render({
      ...COMPONENT,
      serving: [{ targetId: 'target-bluenose', label: 'bluenose/static' }],
    });
    expect(markup).toContain('Upload an archive for deck');
  });

  test('names the Component it would aim at, so two rows are not one act', () => {
    const markup = render({
      ...COMPONENT,
      name: 'api',
      serving: [{ targetId: 'target-folly', label: 'Folly' }],
    });
    expect(markup).toContain('Upload an archive for api');
    expect(markup).not.toContain('Upload an archive for deck');
  });
});
