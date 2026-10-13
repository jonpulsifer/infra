import { describe, expect, test } from 'bun:test';
import {
  BUILD_REPORT_MARKER,
  type BuildReport,
  encodeBuildReport,
  LEGACY_BUILD_REPORT_MARKER,
  parseBuildReport,
} from '../../src/adapters/build/report.ts';

const report: BuildReport = {
  bundleDigest: `sha256:${'b'.repeat(64)}`,
  digest: `sha256:${'a'.repeat(64)}`,
  refs: ['registry.example.test/demo/web'],
  baseDigest: null,
};

const payload = (value: BuildReport) => btoa(JSON.stringify(value));

describe('build report marker', () => {
  test('encoding emits the current marker', () => {
    const line = encodeBuildReport(report);
    expect(line.startsWith(`${BUILD_REPORT_MARKER} `)).toBe(true);
    expect(line).not.toContain(LEGACY_BUILD_REPORT_MARKER);
  });

  test('a line with the current marker parses', () => {
    expect(parseBuildReport(`noise\n${encodeBuildReport(report)}`)).toEqual(
      report,
    );
  });

  test('a line with the legacy marker parses', () => {
    const log = `noise\n${LEGACY_BUILD_REPORT_MARKER} ${payload(report)}\n`;
    expect(parseBuildReport(log)).toEqual(report);
  });

  test('the last report wins across markers', () => {
    const later = { ...report, refs: ['registry.example.test/later'] };
    const log = [
      encodeBuildReport(report),
      `${LEGACY_BUILD_REPORT_MARKER} ${payload(later)}`,
    ].join('\n');
    expect(parseBuildReport(log)).toEqual(later);
  });

  test('a malformed legacy line is skipped', () => {
    const log = `${encodeBuildReport(report)}\n${LEGACY_BUILD_REPORT_MARKER} !!!`;
    expect(parseBuildReport(log)).toEqual(report);
  });
});
