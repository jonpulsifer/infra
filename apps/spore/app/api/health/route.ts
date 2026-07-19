import { getSpore } from '@/lib/spore';

export interface HealthService {
  health(): void | Promise<void>;
}

const healthHeaders = {
  'Cache-Control': 'no-store',
  'Content-Type': 'text/plain; charset=utf-8',
};

export function createHealthGet(
  getHealth: () => HealthService = () => getSpore(),
) {
  return async () => {
    try {
      await getHealth().health();
      return new Response('ok\n', { headers: healthHeaders });
    } catch {
      return new Response('failure\n', {
        status: 503,
        headers: healthHeaders,
      });
    }
  };
}

export const GET = createHealthGet();
