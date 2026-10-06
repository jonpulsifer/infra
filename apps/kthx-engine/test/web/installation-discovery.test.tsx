// The discovery panel shows cloud facts to confirm, not type. Headings are
// humanized schema keys, and a value lands at the path the command gave.
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
    // Addressed through the home-vessel pointer; the document resolves its position.
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
    // Only the `found` arm has `candidates`, and the compiler holds that.
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
    // An entry removed between the ask and the press shifts positions, and
    // `location.project` has no refinement to refuse a misplaced value.
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

  test('an unwritable answer is said in place of its candidates', () => {
    const fact = FACTS[0]!;
    if (fact.kind !== 'found') throw new Error('the fixture lost its arm');

    const markup = renderToStaticMarkup(
      <DiscoveredFactList
        facts={[fact]}
        unwritable={() => 'the vessel this answers for is not declared'}
        onApply={() => undefined}
      />,
    );
    expect(markup).toContain('not declared');
    expect(markup).not.toContain('example-home');
  });

  test('a list-valued key takes the shape its candidate carried', () => {
    // A candidate carries its own value: `sources.buckets` is a list and the
    // home vessel's `shared.sourceBucket` is not.
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
    // The pressed state reads the document, not `fact.suggested`, which a press never changes.
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
    // `Project` and `Artifacts project` end in the same word.
    expect(row(withProject('example-home'))).toContain(
      'vessels.homeVessel.location.project',
    );
  });

  test('a caller with no document states nothing about which value is in force', () => {
    const markup = renderToStaticMarkup(
      <DiscoveredFactList facts={[fact]} onApply={() => undefined} />,
    );
    expect(markup).not.toContain('confirmed');
    expect(markup).not.toContain('stand-in');
  });
});

describe('the narrowing inputs are seeded from the document', () => {
  test('a project the document already names arrives in the box', () => {
    // Without a project, discovery cannot list buckets or signing keys.
    expect(
      narrowingFrom({
        installation: { homeVessel: 'home' },
        vessels: [{ name: 'home', location: { project: 'example-home' } }],
      }),
    ).toMatchObject({ project: 'example-home' });
  });

  test('the key location is read out of the signer this installation holds', () => {
    // The KMS location is a segment of the signer URI, not a key of its own.
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
    // `manifestFields()` makes no `discovery.` key, so only the panel renders these.
    expect(markup).toContain('name="discovery.project"');
    expect(markup).toContain('name="discovery.kmsLocation"');
  });

  test('it sits above the form, where the value is confirmed before it is typed', () => {
    expect(markup.indexOf('name="discovery.project"')).toBeLessThan(
      markup.indexOf('name="sources.buckets.0"'),
    );
  });
});

interface Sent {
  readonly path: string;
  readonly body: unknown;
}

const realFetch = globalThis.fetch;

// Stubs `fetch` under the real typed client, so the request that leaves is checked.
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

    // The command's input is strict, so an empty `kmsLocation` would be refused;
    // an untrimmed project names nothing in the cloud.
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
    // `command` throws when the server did not answer. As `facts: []` it would
    // read as a cloud that has nothing.
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

describe('an answer arrives; a refusal does not', () => {
  // An animated refusal would make a disabled API look like it is still landing.
  const markup = renderToStaticMarkup(
    <DiscoveredFactList facts={FACTS} onApply={() => undefined} />,
  );

  test('a found row rises, one behind the next', () => {
    expect(markup).toContain('animate-rise');
    expect(markup).toContain('calc(var(--i) * 60ms)');
  });

  test('an unavailable row carries no animation at all', () => {
    const unavailable = FACTS.find((fact) => fact.kind === 'unavailable');
    expect(unavailable).toBeDefined();
    const only = renderToStaticMarkup(
      <DiscoveredFactList facts={[unavailable!]} onApply={() => undefined} />,
    );
    expect(only).toContain(
      unavailable!.kind === 'unavailable' ? unavailable!.reason : '',
    );
    expect(only).not.toContain('animate-rise');
    expect(only).not.toContain('animationDelay');
  });
});
