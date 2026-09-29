import { expect, test } from 'bun:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
import { createStorageConformance } from '@earendil-works/pi-agent-core/harness/session/testing';
import { deleteSession } from '../src/index.ts';
import { sessionId, storageFor, withDatabase } from './support.ts';

const database = withDatabase();

const cases = createStorageConformance(async () => {
  const { sql } = database();
  const id = sessionId('conformance');
  const storage = await storageFor(sql, id);
  return {
    storage,
    async [Symbol.asyncDispose]() {
      await storage.close(BACKGROUND_CONTEXT);
      await deleteSession(sql, id);
    },
  };
});

test('the conformance suite has cases', () => {
  expect(cases.length).toBeGreaterThan(0);
});

for (const conformance of cases) {
  test(`${conformance.group} > ${conformance.name}`, () => conformance.run());
}
