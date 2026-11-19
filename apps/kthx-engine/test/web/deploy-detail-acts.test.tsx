// Mounts the Build and Deploy screens and presses their buttons, since which
// Component a press deploys is decided in the screen's handler.
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { DeployView } from '../../src/commands/views.ts';
import {
  BuildScreen,
  DeployScreen,
} from '../../src/web/views/apps/deploy-detail.tsx';
import { DEPLOY_SCENARIOS } from '../fixtures/scenarios.ts';
import {
  type DomShim,
  ELEMENT_NODE,
  type FakeNode,
  installDomShim,
} from '../harness/dom.ts';

// The App's second Component, so a request that names none deploys the wrong one.
const SECOND: DeployView = {
  ...DEPLOY_SCENARIOS.live,
  id: 92,
  buildId: 91,
  componentId: '00000000-0000-4000-8000-0000000000b2',
  component: 'offsite',
  targetId: '00000000-0000-4000-8000-0000000000c2',
  target: 'offsite/kubernetes',
};

let answers: Record<string, unknown> = {};
let calls: { name: string; input: unknown }[] = [];
let dom: DomShim;

beforeAll(() => {
  dom = installDomShim({
    WebSocket: class {
      onmessage: unknown = null;
      onclose: unknown = null;
      onerror: unknown = null;
      close(): void {}
    },
    fetch: async (url: string, init?: { body?: string }) => {
      const name = url.split('/').at(-1) ?? '';
      calls.push({ name, input: JSON.parse(init?.body ?? '{}') });
      if (!(name in answers)) throw new Error(`nothing answers ${name}`);
      return { json: async () => ({ ok: true, value: answers[name] }) };
    },
  });
});

afterAll(() => dom.restore());

beforeEach(() => {
  calls = [];
  answers = { deployApp: { deployId: 93, buildId: 91, phase: 'PENDING' } };
});

function findButton(root: FakeNode, label: string): FakeNode | null {
  if (root.nodeType === ELEMENT_NODE && root.tagName === 'BUTTON') {
    return root.textContent.includes(label) ? root : null;
  }
  for (const child of root.childNodes) {
    const found = findButton(child, label);
    if (found) return found;
  }
  return null;
}

/** The shim dispatches no events, so this calls the handler React attached. */
async function press(container: FakeNode, label: string): Promise<void> {
  const button = findButton(container, label);
  if (!button) throw new Error(`no button reads ${label}`);
  const key = Object.keys(button).find((k) => k.startsWith('__reactProps$'));
  const props = (button as unknown as Record<string, { onClick?: () => void }>)[
    key ?? ''
  ];
  if (!props?.onClick) throw new Error(`${label} has no click handler`);
  await act(async () => {
    props.onClick?.();
  });
}

async function mount(screen: ReactNode): Promise<{
  container: FakeNode;
  unmount: () => void;
}> {
  const container = dom.document.createElement('div');
  const root = createRoot(container as unknown as Element);
  await act(async () => {
    root.render(screen);
  });
  return { container, unmount: () => act(() => root.unmount()) };
}

const deployRequests = () =>
  calls.filter((call) => call.name === 'deployApp').map((call) => call.input);

describe('a detail page deploys the Component it shows', () => {
  test('Deploy this build names the Build’s Component and Target', async () => {
    answers.getBuildDetail = {
      attempt: { ...SECOND, id: null },
      deployId: null,
    };
    const screen = await mount(
      <BuildScreen buildId="91" onNavigate={() => undefined} />,
    );

    await press(screen.container, 'Deploy this build');

    expect(deployRequests()).toEqual([
      {
        name: SECOND.appId,
        component: SECOND.componentId,
        target: SECOND.targetId,
      },
    ]);
    screen.unmount();
  });

  test('a Build of an unplaced Component names no Target', async () => {
    answers.getBuildDetail = {
      attempt: { ...SECOND, id: null, targetId: '' },
      deployId: null,
    };
    const screen = await mount(
      <BuildScreen buildId="91" onNavigate={() => undefined} />,
    );

    await press(screen.container, 'Redeploy');

    expect(deployRequests()).toEqual([
      { name: SECOND.appId, component: SECOND.componentId },
    ]);
    screen.unmount();
  });

  test('Redeploy names the Deploy’s Component and Target', async () => {
    answers.getDeployDetail = { deploy: SECOND };
    const screen = await mount(
      <DeployScreen deployId="92" onNavigate={() => undefined} />,
    );

    await press(screen.container, 'Redeploy');

    expect(deployRequests()).toEqual([
      {
        name: SECOND.appId,
        component: SECOND.componentId,
        target: SECOND.targetId,
      },
    ]);
    screen.unmount();
  });
});
