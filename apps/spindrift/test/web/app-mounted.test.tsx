// Mounts `App` over a stubbed `fetch`. Onboarding replaces the whole app, so
// only a clear "unconfigured" answer reaches it; a refusal or a hang is the product.
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

const OPERATOR = { id: 'usr_test', displayName: 'Operator' };

// `never` is a read that never settles, which a `.catch` cannot see.
let answer:
  | {
      readonly kind: 'ok';
      readonly configured: boolean;
    }
  | { readonly kind: 'throws' }
  | { readonly kind: 'never' } = { kind: 'ok', configured: true };

let dom: DomShim;

beforeAll(() => {
  dom = installDomShim({
    // `useRoute` subscribes with `addEventListener`, which Bun's `globalThis` has.
    location: { hash: '' },
    // The theme toggle reads a stored preference on mount.
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
              configured: answer.kind === 'ok' && answer.configured,
            },
          }),
        };
      }
      // Overview's reads never answer; the screen shows its loading state.
      return await new Promise(() => {});
    },
  });
});

afterAll(() => dom.restore());

beforeEach(() => {
  answer = { kind: 'ok', configured: true };
});

async function mount(): Promise<{ text: () => string; unmount: () => void }> {
  const container = dom.document.createElement('div');
  let root!: Root;
  await act(async () => {
    root = createRoot(container as unknown as Element);
    root.render(<App />);
  });
  // The installation read runs in an effect keyed on the session, one turn later.
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

    expect(screen.text()).toContain('Step 1 of 3');
    // The shell's navigation marks the product.
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
    answer = { kind: 'throws' };

    const screen = await mount();

    expect(screen.text()).toContain('Overview');

    screen.unmount();
  });

  test('a read that never answers is the product once the deadline passes', async () => {
    // The document stays blank until the ask times out.
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
