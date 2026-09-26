import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseLinePlan } from '../src/board/lines.ts';

const FIXTURE = `
; a comment with [brackets] and set_var = TRUNK=nope
[trunk](!)
type = endpoint
[vms-a](trunk-registration)
client_uri = sip:100_a@\${PBX_VOIPMS_SERVER}\\;transport=tls ; a comment
[vms-a](trunk)
set_var = HANDSET=line2
set_var = SCREEN=yes ; screened
[vms-a]
type = auth
password = \${PBX_VOIPMS_PASS_A}
[vms-a-identify]
type = identify
endpoint = vms-a
[line10](handset)
set_var = TRUNK=vms-b
[line2](handset)
set_var = TRUNK=vms-a
`;

describe('the line plan from pjsip.conf', () => {
  test('pairs each line with its trunk, account and screen', () => {
    expect(parseLinePlan(FIXTURE)).toEqual([
      { line: 'line2', trunk: 'vms-a', account: '100_a', screened: true },
      { line: 'line10', trunk: 'vms-b', account: null, screened: false },
    ]);
  });

  test('an empty file names no lines', () => {
    expect(parseLinePlan('')).toEqual([]);
  });

  // The board reads the template the folly PBX renders; this keeps the two in
  // step. turbo.json lists the file as an input to this package's tests.
  const folly = join(
    import.meta.dir,
    '../../../clusters/folly/apps/pbx/config/pjsip.conf',
  );
  test.skipIf(!existsSync(folly))(
    'reads the four lines of the folly PBX',
    () => {
      const plan = parseLinePlan(readFileSync(folly, 'utf8'));
      expect(plan.map((p) => p.line)).toEqual([
        'line1',
        'line2',
        'line3',
        'line4',
      ]);
      for (const p of plan) {
        expect(p.trunk).toMatch(/^vms-/);
        expect(p.account).toMatch(/^\d+_/);
      }
      expect(plan.filter((p) => p.screened).map((p) => p.line)).toEqual([
        'line4',
      ]);
    },
  );
});
