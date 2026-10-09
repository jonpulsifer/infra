import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileImage } from '../src/sandbox-image.ts';
import { RecordingLog } from './support.ts';

const OLD =
  'ghcr.io/jonpulsifer/mate-sandbox:latest@sha256:1111111111111111111111111111111111111111111111111111111111111111';
const NEW =
  'ghcr.io/jonpulsifer/mate-sandbox:latest@sha256:2222222222222222222222222222222222222222222222222222222222222222';

function file(): string {
  return join(mkdtempSync(join(tmpdir(), 'mate-sandbox-image-')), 'image');
}

describe('the sandbox image file', () => {
  test('names the image the file holds at each read', async () => {
    const path = file();
    writeFileSync(path, `${OLD}\n`);
    const log = new RecordingLog();
    const image = fileImage(path, log);

    expect(await image()).toBe(OLD);
    expect(await image()).toBe(OLD);
    writeFileSync(path, NEW);
    expect(await image()).toBe(NEW);
    expect(log.of('sandbox image').map((e) => e.fields?.image)).toEqual([
      OLD,
      NEW,
    ]);
  });

  test('keeps the last image while the file is gone or empty', async () => {
    const path = file();
    writeFileSync(path, OLD);
    const log = new RecordingLog();
    const image = fileImage(path, log);
    await image();

    writeFileSync(path, ' \n');
    expect(await image()).toBe(OLD);
    rmSync(path);
    expect(await image()).toBe(OLD);
    expect(
      log.of('could not read the sandbox image; keeping the last one'),
    ).toHaveLength(2);
  });

  test('fails a mint when it has never read an image', async () => {
    const path = file();
    const image = fileImage(path, new RecordingLog());
    await expect(image()).rejects.toThrow(`no sandbox image in ${path}`);
    writeFileSync(path, '');
    await expect(image()).rejects.toThrow('the file is empty');
  });
});
