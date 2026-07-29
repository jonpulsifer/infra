import { createClient } from './client.ts';
import { waitForSchema } from './schema-readiness.ts';

const client = createClient();
try {
  await waitForSchema(client);
} finally {
  await client.close();
}
