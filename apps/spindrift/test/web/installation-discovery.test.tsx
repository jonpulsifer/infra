/**
 * Cloud facts shown for confirmation rather than typed.
 *
 * Four claims:
 *
 * 1. **The panel is on the settings surface.** The whole criterion is that an
 *    operator confirms rather than types, and a panel nothing mounts confirms
 *    nothing. Asserted against the real `InstallationSettingsView`, so removing
 *    the element fails here rather than passing quietly.
 * 2. **The two arms read as two different things.** A field the cloud could not
 *    answer shows the sentence saying why; a field it answered with nothing
 *    shows that it is empty. A panel that rendered a refusal as a blank would be
 *    the original defect wearing a UI.
 * 3. **Nothing here names a manifest key.** The headings are the schema's own
 *    keys humanized, and applying a candidate writes at the path the command
 *    gave — so a key leaving the schema leaves this panel too, rather than
 *    leaving a control for a field that no longer exists.
 * 4. **The request carries the narrowing the operator typed, and every way of
 *    failing comes back as a sentence.** This repo has no DOM, so the assertion
 *    is against `askInstallationCloud` and `DiscoveryRefusal` directly — the two
 *    pieces the panel is a shell around — with `fetch` stubbed beneath the real
 *    typed client.
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  DiscoveredCandidate,
  DiscoveredFact,
} from '../../src/commands/installation/discover.ts';
import { HOME_VESSEL } from '../../src/commands/installation/discover.ts';
import { manifestFields } from '../../src/web/forms/manifest.ts';
import {
  applyDiscovered,
  askInstallationCloud,
  DiscoveredFactList,
  DiscoveryRefusal,
  narrowingFrom,
  unwritable,
} from '../../src/web/views/auth/discovery.tsx';
import { InstallationSettingsView } from '../../src/web/views/auth/installation.tsx';
import { fixtureManifest } from '../harness/installation.ts';

const FACTS: readonly DiscoveredFact[] = [
  {
    // The home vessel's own project, addressed by the pointer that names it —
    // three of the five facts are that boundary's properties now, and the
    // position it holds is the document's to give at the moment of the press.
    path: ['vessels', HOME_VESSEL, 'location', 'project'],
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
    expect(markup).toContain('Project');
    expect(markup).toContain('Signer');
  });
});

describe('confirming a value edits the document at the path it came with', () => {
  const document = {
    installation: { homeVessel: 'home' },
    vessels: [
      { name: 'cluster' },
      { name: 'home', location: { project: 'typed-by-hand' } },
    ],
    sources: { buckets: [] },
  };

  test('the value lands at the path, and nothing else moves', () => {
    const fact = FACTS[0]!;
    // `candidates` is only reachable on the arm that has one — which is the
    // property the command's two arms exist for, asserted here by the compiler
    // rather than by an expectation.
    if (fact.kind !== 'found') throw new Error('the fixture lost its arm');
    expect(applyDiscovered(document, fact, fact.candidates[0]!)).toEqual({
      installation: { homeVessel: 'home' },
      vessels: [
        { name: 'cluster' },
        { name: 'home', location: { project: 'example-home' } },
      ],
      sources: { buckets: [] },
    });
  });

  test('the vessel is found by name, not at the position the answer carried', () => {
    // An entry removed between the ask and the press moves every entry after
    // it. A position carried from the server would then address whichever
    // boundary slid into it, and `location.project` has no refinement that
    // would refuse the value.
    const fact = FACTS[0]!;
    if (fact.kind !== 'found') throw new Error('the fixture lost its arm');
    const shifted = { ...document, vessels: [document.vessels[1]!] };
    expect(applyDiscovered(shifted, fact, fact.candidates[0]!)).toEqual({
      ...document,
      vessels: [{ name: 'home', location: { project: 'example-home' } }],
    });
  });

  test('a document with nowhere to put the answer is left alone', () => {
    const fact = FACTS[0]!;
    if (fact.kind !== 'found') throw new Error('the fixture lost its arm');
    const homeless = { ...document, vessels: [{ name: 'cluster' }] };
    expect(applyDiscovered(homeless, fact, fact.candidates[0]!)).toBe(homeless);
    expect(unwritable(fact, homeless)).toContain('not declared');
  });

  test('a value the declaration owns is said, not offered', () => {
    // The panel edits the same document the form below it locks, so a candidate
    // for a governed path is a button whose only outcome is a refused save.
    const fact = FACTS[0]!;
    if (fact.kind !== 'found') throw new Error('the fixture lost its arm');
    const reason = unwritable(fact, document, (at) => at[0] === 'vessels');
    expect(reason).toContain('mounted declaration');

    const markup = renderToStaticMarkup(
      <DiscoveredFactList
        facts={[fact]}
        unwritable={() => reason}
        onApply={() => undefined}
      />,
    );
    expect(markup).toContain('mounted declaration');
    expect(markup).not.toContain('example-home');
  });

  test('a list-valued key takes the shape its candidate carried', () => {
    // The reason a candidate carries a value at all: `sources.buckets` is a
    // list and the home vessel's `shared.sourceBucket` is not, and a panel
    // deriving that would be a panel with an opinion about the schema.
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

describe('a row is a reconciliation, not a row of buttons', () => {
  const fact = FACTS[0]!;
  if (fact.kind !== 'found') throw new Error('the fixture lost its arm');

  function withProject(project: string): unknown {
    return {
      installation: { homeVessel: 'home' },
      vessels: [{ name: 'home', location: { project } }],
    };
  }

  function row(document: unknown): string {
    return renderToStaticMarkup(
      <DiscoveredFactList
        facts={[fact]}
        document={document}
        onApply={() => undefined}
      />,
    );
  }

  test('confirming a value is visible, because the row reads the document', () => {
    // The defect this replaces: the selected style came from `fact.suggested`,
    // a property of the *server's* answer that is identical before and after a
    // press. An operator confirmed a discovered project and every pixel on the
    // screen stayed where it was.
    const before = row(withProject('typed-by-hand'));
    const after = row(withProject('example-home'));
    expect(before).not.toEqual(after);
    expect(before).toContain('aria-pressed="false"');
    expect(after).toContain('aria-pressed="true"');
  });

  test('a row says what the document holds and whether it is settled', () => {
    expect(row(withProject('typed-by-hand'))).toContain('typed-by-hand');
    expect(row(withProject('typed-by-hand'))).toContain('stand-in');
    expect(row(withProject('example-home'))).toContain('confirmed');
  });

  test('the whole path is on the row, because the tail is ambiguous', () => {
    // Two of the five answers humanize to the same word: `Project` is the home
    // vessel's own and `Artifacts project` is its shared one, and a panel
    // showing only the last segment showed the same heading twice.
    expect(row(withProject('example-home'))).toContain(
      'vessels.homeVessel.location.project',
    );
  });

  test('a caller with no document states nothing about which value is in force', () => {
    // The honest absence: the settings screen passes a document and the row is
    // a comparison; a caller that has none gets candidates and no verdict,
    // rather than a verdict computed against nothing.
    const markup = renderToStaticMarkup(
      <DiscoveredFactList facts={[fact]} onApply={() => undefined} />,
    );
    expect(markup).not.toContain('confirmed');
    expect(markup).not.toContain('stand-in');
  });
});

describe('the narrowing inputs are seeded from the document', () => {
  test('a project the document already names arrives in the box', () => {
    // Discovery is staged deliberately: with no project, buckets and signing
    // keys answer "name a project and run discovery again" — and the candidate
    // that would unblock it is labelled `<project> — this deployment's own
    // credential`, so an operator who typed what they read typed a project
    // that does not exist.
    expect(
      narrowingFrom({
        installation: { homeVessel: 'home' },
        vessels: [{ name: 'home', location: { project: 'example-home' } }],
      }),
    ).toMatchObject({ project: 'example-home' });
  });

  test('the key location is read out of the signer this installation holds', () => {
    // Not a manifest key of its own — it is a segment inside the signer, and
    // reading it back is cheaper for an operator than finding the console page
    // that lists it.
    expect(
      narrowingFrom({
        supplyChain: {
          signer:
            'gcpkms://projects/example-home/locations/us-central1/keyRings/r/cryptoKeys/k',
        },
      }),
    ).toMatchObject({ kmsLocation: 'us-central1' });
  });

  test('a document that names neither asks for everything', () => {
    expect(narrowingFrom({})).toEqual({ project: '', kmsLocation: '' });
  });
});

const manifest = await fixtureManifest();

describe('the panel is part of the settings surface', () => {
  const markup = renderToStaticMarkup(
    <InstallationSettingsView
      fields={manifestFields()}
      document={manifest as unknown}
      errors={new Map()}
      outcome={null}
      saving={false}
      onChange={() => undefined}
      onSave={() => undefined}
      onReload={() => undefined}
    />,
  );

  test('the screen an operator edits the manifest on offers the ask', () => {
    // The second half of the criterion, and the half a component test cannot
    // reach: facts are shown *for confirmation*, which is only true if the
    // panel is on the screen that edits the manifest. Both inputs are named
    // here because `manifestFields()` produces no `discovery.` key — nothing
    // but the panel can satisfy this.
    expect(markup).toContain('name="discovery.project"');
    expect(markup).toContain('name="discovery.kmsLocation"');
  });

  test('it sits above the form, where the value is confirmed before it is typed', () => {
    // Order, not just presence: a confirmation offered underneath the field it
    // would have saved a typo in is a confirmation nobody reaches first.
    expect(markup.indexOf('name="discovery.project"')).toBeLessThan(
      markup.indexOf('name="sources.buckets.0"'),
    );
  });
});

/** What the stubbed transport recorded of one request. */
interface Sent {
  readonly path: string;
  readonly body: unknown;
}

const realFetch = globalThis.fetch;

/**
 * One ask, with a stubbed `fetch` under the real typed client.
 *
 * Under the client rather than in place of it: the claim is about the request
 * that leaves the browser, and a stub of `command` itself would assert only
 * that the panel calls a function this test also wrote.
 */
async function ask(
  narrowing: { project: string; kmsLocation: string },
  respond: () => Response,
): Promise<{
  readonly sent: readonly Sent[];
  readonly answer: Awaited<ReturnType<typeof askInstallationCloud>>;
}> {
  const sent: Sent[] = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    sent.push({
      path: String(input),
      body: JSON.parse(String(init?.body ?? 'null')) as unknown,
    });
    return respond();
  }) as typeof fetch;
  try {
    return { sent, answer: await askInstallationCloud(narrowing) };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const NO_FACTS = () => Response.json({ ok: true, value: { facts: [] } });

describe('what the panel asks the cloud', () => {
  test('an empty input is absent from the request, not sent empty', async () => {
    const { sent, answer } = await ask(
      { project: '  example-home  ', kmsLocation: '   ' },
      NO_FACTS,
    );

    // Exactly this object: the command's input is `.strict()`, so an empty
    // `kmsLocation` is a rejected request rather than a first pass, and an
    // untrimmed project is a project id nothing in the cloud is named.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toEqual({ project: 'example-home' });
    expect(answer).toEqual({ facts: [] });
  });

  test('both narrowings are sent when both are given', async () => {
    const { sent } = await ask(
      { project: 'example-home', kmsLocation: ' a-region ' },
      NO_FACTS,
    );

    expect(sent[0]?.body).toEqual({
      project: 'example-home',
      kmsLocation: 'a-region',
    });
  });

  test('a refused command comes back as its sentence', async () => {
    const { answer } = await ask({ project: '', kmsLocation: '' }, () =>
      Response.json({
        ok: false,
        failure: {
          code: 'NOT_DEPLOYABLE',
          message: 'this installation mounts no cloud federation credential',
        },
      }),
    );

    expect(answer).toEqual({
      refusal: 'this installation mounts no cloud federation credential',
    });
  });

  test('a transport that never reached the command layer is a sentence too', async () => {
    // The one case `command` throws on: a proxy answering HTML is not the
    // server answering. Swallowed into `facts: []` it would render as a cloud
    // that confirmed nothing exists.
    const { answer } = await ask(
      { project: '', kmsLocation: '' },
      () => new Response('<html>a proxy</html>', { status: 502 }),
    );

    expect(answer).not.toHaveProperty('facts');
    expect(answer).toHaveProperty('refusal');
  });
});

describe('a refusal is shown as a fact about the installation', () => {
  const markup = renderToStaticMarkup(
    <DiscoveryRefusal reason="this installation mounts no cloud federation credential" />,
  );

  test('it is announced, carries its sentence, and is not a field error', () => {
    expect(markup).toContain('role="alert"');
    expect(markup).toContain(
      'this installation mounts no cloud federation credential',
    );
    expect(markup).toContain('not a field to correct');
  });
});
