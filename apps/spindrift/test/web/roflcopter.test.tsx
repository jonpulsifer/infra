import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DeployPhase } from '../../src/commands/views.ts';
import {
  ROTOR_WIDTH,
  Roflcopter,
  rotorFrame,
} from '../../src/web/components/roflcopter.tsx';
import { AppShell } from '../../src/web/components/shell.tsx';
import { enteredLive } from '../../src/web/views/apps/deploy-detail.tsx';
import { Gate } from '../../src/web/views/auth/gate.tsx';

const OPERATOR = { id: 'operator', displayName: 'Ada Operator' };

describe('rotorFrame: the rotor and tail as a pure function of the tick', () => {
  test('every tick keeps the rotor 23 characters and each tail cell 3', () => {
    // More than one lap of the tape, so the wraparound runs.
    for (let tick = 0; tick < 50; tick++) {
      const frame = rotorFrame(tick);
      expect(frame.rotor.length).toBe(ROTOR_WIDTH);
      expect(frame.rotor.length).toBe(23);
      for (const cell of frame.tail) expect(cell.length).toBe(3);
    }
  });

  test('the rotor scrolls one character of tape per tick', () => {
    const first = rotorFrame(0);
    const second = rotorFrame(1);
    expect(second.rotor.slice(0, ROTOR_WIDTH - 1)).toBe(first.rotor.slice(1));
  });

  test('the tape opens on ROFL, at rest', () => {
    expect(rotorFrame(0).rotor).toBe('ROFL:ROFL:LOL:ROFL:ROFL');
  });

  test('the tail swaps frame every other tick, not every tick', () => {
    const [a, b, c] = [rotorFrame(0), rotorFrame(1), rotorFrame(2)];
    expect(a.tail).toEqual(b.tail);
    expect(a.tail).not.toEqual(c.tail);
  });

  test('a negative tick still resolves inside the tape', () => {
    expect(() => rotorFrame(-5)).not.toThrow();
    expect(rotorFrame(-5).rotor.length).toBe(ROTOR_WIDTH);
  });
});

describe('enteredLive: the fly-over fires on a transition, never on a level', () => {
  const at = (phase: DeployPhase) => phase;

  test('a genuine move into LIVE, from any phase before it', () => {
    for (const before of ['PENDING', 'APPLYING', 'WAITING'] as const) {
      expect(enteredLive(at(before), 'LIVE')).toBe(true);
    }
  });

  test('never for a phase this tab has not seen yet — the first read', () => {
    expect(enteredLive(undefined, 'LIVE')).toBe(false);
  });

  test('never for a poll that finds the same LIVE it already reported', () => {
    expect(enteredLive('LIVE', 'LIVE')).toBe(false);
  });

  test('never for a move to anything other than LIVE', () => {
    expect(enteredLive('APPLYING', 'WAITING')).toBe(false);
    expect(enteredLive('WAITING', 'FAILED')).toBe(false);
    expect(enteredLive('LIVE', 'FAILED')).toBe(false);
  });
});

describe('Roflcopter', () => {
  test('the ambient shape draws the art, aria-hidden, in the mono face', () => {
    const markup = renderToStaticMarkup(<Roflcopter />);
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('ROFL:ROFL:LOL:ROFL:ROFL');
    expect(markup).toContain('___^___ _');
    expect(markup).toContain('----------/');
    expect(markup).toMatch(/<pre[^>]*>/);
  });

  test('a flyover instance draws nothing until flyover() is called', () => {
    expect(renderToStaticMarkup(<Roflcopter flyover />)).toBe('');
  });

  test('parked draws the same art, at rest, beside whatever it is given', () => {
    const markup = renderToStaticMarkup(<Roflcopter parked />);
    expect(markup).toContain('ROFL:ROFL:LOL:ROFL:ROFL');
  });
});

describe('server rendering carries the mascot without touching a window', () => {
  test('the gate — nobody has signed in on this installation yet', () => {
    const render = () =>
      renderToStaticMarkup(
        <Gate claimed={true} onSignedIn={() => undefined} />,
      );
    expect(render).not.toThrow();
    expect(render()).toContain('ROFL:ROFL:LOL:ROFL:ROFL');
  });

  test('the shell — the silent flyover instance mounted once', () => {
    const render = () =>
      renderToStaticMarkup(
        <AppShell
          path="/"
          principal={OPERATOR}
          onNavigate={() => undefined}
          onSignOut={() => undefined}
          themeControl={<span>theme</span>}
        >
          <p>screen</p>
        </AppShell>,
      );
    expect(render).not.toThrow();
  });
});
