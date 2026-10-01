import { z } from 'zod';

/** One DNS label, the only shape a kthx site name takes. */
export const siteName = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
