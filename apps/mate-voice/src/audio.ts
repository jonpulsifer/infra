/**
 * PCM shapes between Discord and ElevenLabs. Discord's decoded frames are
 * s16le 48 kHz stereo; ElevenLabs hears s16le mono and speaks s16le mono at
 * the rate the engine declares, which the player needs back at 48 kHz stereo.
 */

/** Averages the two channels of s16le stereo into s16le mono. */
export function downmixToMono(stereo: Buffer): Buffer {
  const frames = Math.floor(stereo.length / 4);
  const mono = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const left = stereo.readInt16LE(i * 4);
    const right = stereo.readInt16LE(i * 4 + 2);
    mono.writeInt16LE(Math.round((left + right) / 2), i * 2);
  }
  return mono;
}

/**
 * Lifts s16le mono at `rate` to s16le 48 kHz stereo, interpolating between
 * samples so a 24 kHz voice does not hiss. `rate` must divide 48 000.
 */
export function upsampleToStereo48k(mono: Buffer, rate: number): Buffer {
  const factor = 48_000 / rate;
  if (!Number.isInteger(factor) || factor < 1) {
    throw new Error(`cannot upsample ${rate} Hz to 48 kHz by a whole factor`);
  }
  const samples = Math.floor(mono.length / 2);
  const out = Buffer.alloc(samples * factor * 4);
  for (let i = 0; i < samples; i++) {
    const here = mono.readInt16LE(i * 2);
    const next = i + 1 < samples ? mono.readInt16LE((i + 1) * 2) : here;
    for (let k = 0; k < factor; k++) {
      const value = Math.round(here + ((next - here) * k) / factor);
      const at = (i * factor + k) * 4;
      out.writeInt16LE(value, at);
      out.writeInt16LE(value, at + 2);
    }
  }
  return out;
}

/** The sample rate a `pcm_<rate>` format names, or null for anything else. */
export function pcmRate(format: string): number | null {
  const match = /^pcm_(\d+)$/.exec(format);
  return match ? Number(match[1]) : null;
}
