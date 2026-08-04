/**
 * What a signed-in operator is actually handed, mounted.
 *
 * `onboarding.test.tsx` asserts that `SignedIn` renders the wizard when it is
 * *told* the installation is unconfigured. Nothing asserted the sentence before
 * that one: that `App` asks, and turns the answer into the state `SignedIn`
 * branches on. That gap is not a formality — the whole feature hangs off four
 * lines of one effect, and with them mutated to answer `configured` always, or
 * deleted outright, the suite stayed green while the wizard became unreachable
 * and the product became a blank page respectively.
 *
 * It is the same defect slice 2 shipped and this ticket's own test header cites:
 * a discovery panel every test passed around and nothing observed being mounted.
 * The lesson taken twice is that a claim about a component's *branches* has to
 * be made against the component, so this mounts `App` itself and answers its two
 * reads over a stubbed `fetch` — `client.ts` and `auth-client.ts` reach the
 * network through that one global and nothing else, which is the whole seam.
 *
 * Three answers and three screens, and the asymmetry is the point: onboarding
 * replaces the entire application, so it is the answer that has to be *earned*.
 * A refusal, a hang, and anything that is not a clear "nobody has configured
 * this" all resolve to the product, which takes nothing away and leaves Settings
 * reaching every value the wizard would have asked for.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DEFAULT_PLACEHOLDER_MANIFEST } from '../../src/config/manifest.ts';
import { App } from '../../src/web/app.tsx';
import { type DomShim, installDomShim } from '../harness/dom.ts';

/** The operator the session answers with; `App` only reads the principal. */
const OPERATOR = { id: 'usr_test', displayName: 'Operator' };

/**
 * How `getInstallationManifest` answers this test, set per case.
 *
 * `null` is the stall: the read never settles, which is a proxy holding a
 * connection open or a pod mid-rollout, and is the one failure mode a `.catch`
 * cannot see.
 */
let answer:
  | {
      readonly kind: 'ok';
      readonly configured: boolean;
      readonly declarationDivergence?: readonly string[];
    }
  | { readonly kind: 'throws' }
  | { readonly kind: 'never' } = { kind: 'ok', configured: true };

let dom: DomShim;

beforeAll(() => {
  dom = installDomShim({
    // `useRoute` reads the hash through `useSyncExternalStore` and subscribes
    // with `addEventListener`, which Bun's `globalThis` already implements.
    location: { hash: '' },
    // The shell's theme toggle reads a stored preference on mount. Nothing here
    // is about the theme; an empty store is the "no preference" case and is the
    // one that needs no opinion.
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
    },
    fetch: async (url: string) => {
      if (url.endsWith('/session')) {
        return {
          json: async () => ({
            ok: true,
            value: {
              principal: OPERATOR,
              claimed: true,
              gatewayUnlinked: false,
            },
          }),
        };
      }
      if (url.endsWith('getInstallationManifest')) {
        if (answer.kind === 'throws') throw new Error('the socket went away');
        if (answer.kind === 'never') return await new Promise(() => {});
        return {
          json: async () => ({
            ok: true,
            value: {
              manifest: DEFAULT_PLACEHOLDER_MANIFEST,
              declaration: null,
              declarationDivergence:
                answer.kind === 'ok'
                  ? (answer.declarationDivergence ?? [])
                  : [],
              configured: answer.kind === 'ok' && answer.configured,
            },
          }),
        };
      }
      // Overview's four reads. They are not what is under test and the screen
      // renders its own loading state until they answer, so they never do.
      return await new Promise(() => {});
    },
  });
});

afterAll(() => dom.restore());

beforeEach(() => {
  answer = { kind: 'ok', configured: true };
});

/** Mount `App` and let both reads settle. */
async function mount(): Promise<{ text: () => string; unmount: () => void }> {
  const container = dom.document.createElement('div');
  let root!: Root;
  await act(async () => {
    root = createRoot(container as unknown as Element);
    root.render(<App />);
  });
  // The installation read is issued by an effect keyed on the session's answer,
  // so it is a second turn of the loop rather than part of the first.
  await act(async () => {});
  return {
    text: () => container.textContent,
    unmount: () => {
      act(() => root.unmount());
    },
  };
}

describe('the installation decides which application is rendered', () => {
  test('an installation nobody has configured is handed the wizard', async () => {
    answer = { kind: 'ok', configured: false };

    const screen = await mount();

    expect(screen.text()).toContain('Step 1 of 4');
    // And not underneath it: the shell's navigation is the fingerprint of the
    // product this replaces.
    expect(screen.text()).not.toContain('Overview');

    screen.unmount();
  });

  test('a configured installation is handed the product', async () => {
    answer = { kind: 'ok', configured: true };

    const screen = await mount();

    expect(screen.text()).toContain('Overview');
    expect(screen.text()).not.toContain('Step 1 of 4');

    screen.unmount();
  });

  test('a read that fails is the product, not onboarding', async () => {
    // Onboarding is the more disruptive answer, so a transport failure resolves
    // to the state that takes nothing away.
    answer = { kind: 'throws' };

    const screen = await mount();

    expect(screen.text()).toContain('Overview');

    screen.unmount();
  });

  test('a read that never answers is the product once the deadline passes', async () => {
    // The failure a `.catch` cannot see. Before the deadline the whole document
    // is blank — no chrome, no sign-out — for as long as the socket stays open,
    // which is the state a proxy holding a connection leaves an operator in.
    answer = { kind: 'never' };
    jest.useFakeTimers();
    try {
      const screen = await mount();

      expect(screen.text()).toBe('');

      await act(async () => {
        jest.advanceTimersByTime(60_000);
      });

      expect(screen.text()).toContain('Overview');

      screen.unmount();
    } finally {
      jest.useRealTimers();
    }
  });
});

/**
 * Ticket 78's fourth criterion: a disagreement is visible somewhere an
 * operator passes anyway, not only on the Settings screen.
 *
 * `AppShell` wraps every screen `Screen` renders, and this is the read that
 * already decides `configured` vs `unconfigured` — so a divergence answered
 * in the same breath costs nothing further to show on every one of them. The
 * claim is about `App`/`SignedIn`, the same components the tests above mount,
 * for the same reason those are asserted against the real branch rather than
 * against `AppShell` handed a divergence directly: a banner nothing wires
 * confirms nothing.
 */
describe('a divergent declaration is announced on the product surface', () => {
  test('a non-empty declarationDivergence is shown, unprompted', async () => {
    answer = {
      kind: 'ok',
      configured: true,
      declarationDivergence: ['build.zeroConfigFrontend'],
    };

    const screen = await mount();

    expect(screen.text()).toContain(
      'The mounted declaration no longer matches this installation.',
    );
    expect(screen.text()).toContain('Review it in Settings');

    screen.unmount();
  });

  test('an empty declarationDivergence says nothing', async () => {
    answer = { kind: 'ok', configured: true, declarationDivergence: [] };

    const screen = await mount();

    expect(screen.text()).not.toContain('mounted declaration');

    screen.unmount();
  });
});
