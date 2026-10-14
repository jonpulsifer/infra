/**
 * `bun run smoke` proves the native and WASM pieces the bridge cannot do
 * without load where it runs: DAVE through @snazzah/davey, and Opus through
 * opusscript, round-tripping one 20 ms frame. The image build runs it, so a
 * runner whose davey binary does not load never ships.
 */
import { generateDependencyReport } from '@discordjs/voice';
import { DAVE_PROTOCOL_VERSION, DAVESession, VERSION } from '@snazzah/davey';
import OpusScript from 'opusscript';
import { CHANNELS, SAMPLE_RATE, tone } from './playback.ts';

const FRAME_SAMPLES = 960;
const FRAME_BYTES = FRAME_SAMPLES * CHANNELS * 2;

function fail(message: string): never {
  console.error(`smoke: ${message}`);
  process.exit(1);
}

const session = new DAVESession(DAVE_PROTOCOL_VERSION, '1', '1');
const keyPackage = session.getSerializedKeyPackage();
if (keyPackage.length === 0) fail('davey produced an empty key package');

const opus = new OpusScript(
  SAMPLE_RATE,
  CHANNELS,
  OpusScript.Application.AUDIO,
);
const frame = tone(440, 20).subarray(0, FRAME_BYTES);
if (frame.length !== FRAME_BYTES) fail(`tone frame is ${frame.length} bytes`);
const packet = opus.encode(frame, FRAME_SAMPLES);
const decoded = opus.decode(packet);
opus.delete();
if (packet.length === 0 || decoded.length !== FRAME_BYTES) {
  fail(`opus round trip gave ${packet.length}B packet, ${decoded.length}B pcm`);
}

console.log(
  JSON.stringify({
    davey: VERSION,
    daveProtocol: DAVE_PROTOCOL_VERSION,
    keyPackageBytes: keyPackage.length,
    opusPacketBytes: packet.length,
  }),
);
console.log(generateDependencyReport());
