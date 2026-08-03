/**
 * The confirmation panel ticket 32 slice 2 exists to build.
 *
 * Two claims, and neither is about a request:
 *
 * 1. **The two arms read as two different things.** A field the cloud could not
 *    answer shows the sentence saying why; a field it answered with nothing
 *    shows that it is empty. A panel that rendered a refusal as a blank would be
 *    the original defect wearing a UI.
 * 2. **Nothing here names a manifest key.** The headings are the schema's own
 *    keys humanized, and applying a candidate writes at the path the command
 *    gave — so ticket 33 removing a key removes it from this panel too, rather
 *    than leaving a control for a field that no longer exists.
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  DiscoveredCandidate,
  DiscoveredFact,
} from '../../src/commands/installation/discover.ts';
import {
  applyDiscovered,
  DiscoveredFactList,
} from '../../src/web/views/auth/discovery.tsx';

const FACTS: readonly DiscoveredFact[] = [
  {
    path: ['cloud', 'homeVesselProject'],
    kind: 'found',
    candidates: [{ label: 'example-home', value: 'example-home' }],
    suggested: { label: 'example-home', value: 'example-home' },
  },
  {
    path: ['sources', 'buckets'],
    kind: 'unavailable',
    reason:
      'the Cloud Storage API is not enabled, so the buckets in example-home could not be listed',
  },
  {
    path: ['supplyChain', 'signer'],
    kind: 'found',
    candidates: [],
    suggested: null,
  },
];

function panel(): string {
  return renderToStaticMarkup(
    <DiscoveredFactList facts={FACTS} onApply={() => undefined} />,
  );
}

describe('what the panel shows', () => {
  const markup = panel();

  test('a discovered value is offered as a thing to confirm', () => {
    expect(markup).toContain('example-home');
  });

  test('a refusal is shown as the sentence it came with', () => {
    expect(markup).toContain('the Cloud Storage API is not enabled');
  });

  test('an honest empty says so rather than showing nothing', () => {
    // The whole claim, on the screen: this reads differently from the row above
    // it, and neither reads like a blank field waiting to be typed in.
    expect(markup).toContain('Nothing of this kind exists here');
  });

  test('headings are the schema keys humanized, not written here', () => {
    expect(markup).toContain('Home vessel project');
    expect(markup).toContain('Signer');
  });
});

describe('confirming a value edits the document at the path it came with', () => {
  const document = {
    cloud: { homeVesselProject: 'typed-by-hand' },
    sources: { buckets: [], defaultBucket: 'typed-by-hand' },
  };

  test('the value lands at the path, and nothing else moves', () => {
    const fact = FACTS[0]!;
    // `candidates` is only reachable on the arm that has one — which is the
    // property the command's two arms exist for, asserted here by the compiler
    // rather than by an expectation.
    if (fact.kind !== 'found') throw new Error('the fixture lost its arm');
    expect(applyDiscovered(document, fact, fact.candidates[0]!)).toEqual({
      cloud: { homeVesselProject: 'example-home' },
      sources: { buckets: [], defaultBucket: 'typed-by-hand' },
    });
  });

  test('a list-valued key takes the shape its candidate carried', () => {
    // The reason a candidate carries a value at all: `sources.buckets` is a
    // list and `sources.defaultBucket` is not, and a panel deriving that would
    // be a panel with an opinion about the schema.
    const bucket: DiscoveredCandidate = {
      label: 'a-bucket',
      value: ['a-bucket'],
    };
    const fact: DiscoveredFact = {
      path: ['sources', 'buckets'],
      kind: 'found',
      candidates: [bucket],
      suggested: bucket,
    };
    expect(applyDiscovered(document, fact, bucket)).toMatchObject({
      sources: { buckets: ['a-bucket'] },
    });
  });
});
