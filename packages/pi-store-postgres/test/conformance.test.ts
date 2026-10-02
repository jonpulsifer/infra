import { describe, expect, it } from 'bun:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { registerStorageConformance } from '@earendil-works/pi-durable/testing';
import { deleteStorage, openStorage } from '../src/index.ts';
import { sessionId, withDatabase } from './support.ts';

const database = withDatabase();

registerStorageConformance(
  { describe, expect, it },
  'pi-durable storage conformance',
  async (use) => {
    const { sql } = database();
    const id = sessionId('conformance');
    const storage = await openStorage(sql, id);
    try {
      await use(storage);
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
      await deleteStorage(sql, id);
    }
  },
);
