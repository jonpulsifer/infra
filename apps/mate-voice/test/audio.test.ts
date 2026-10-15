import { describe, expect, test } from 'bun:test';
import { downmixToMono, pcmRate, upsampleToStereo48k } from '../src/audio.ts';

describe('pcm shapes', () => {
  test('downmix averages the channels', () => {
    const stereo = Buffer.alloc(8);
    stereo.writeInt16LE(100, 0);
    stereo.writeInt16LE(300, 2);
    stereo.writeInt16LE(-50, 4);
    stereo.writeInt16LE(-150, 6);
    const mono = downmixToMono(stereo);
    expect([mono.readInt16LE(0), mono.readInt16LE(2)]).toEqual([200, -100]);
  });

  test('upsampling 24 kHz mono to 48 kHz stereo interpolates and doubles up', () => {
    const mono = Buffer.alloc(4);
    mono.writeInt16LE(0, 0);
    mono.writeInt16LE(1000, 2);
    const out = upsampleToStereo48k(mono, 24_000);
    expect(out.length).toBe(16);
    const samples = [0, 4, 8, 12].map((at) => [
      out.readInt16LE(at),
      out.readInt16LE(at + 2),
    ]);
    expect(samples).toEqual([
      [0, 0],
      [500, 500],
      [1000, 1000],
      [1000, 1000],
    ]);
    expect(() => upsampleToStereo48k(mono, 44_100)).toThrow('whole factor');
  });

  test('reads the rate a pcm format names', () => {
    expect(pcmRate('pcm_24000')).toBe(24_000);
    expect(pcmRate('ulaw_8000')).toBeNull();
  });
});
