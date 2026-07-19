import { getSpore } from '@/lib/spore';

export interface BootRouteDecision {
  readonly status: number;
  readonly content: string;
}

export interface BootRouteService {
  decideBoot(macAddress: string): BootRouteDecision;
}

type BootRouteContext = { params: Promise<{ mac: string }> };

const ipxeHeaders = {
  'Cache-Control': 'no-store',
  'Content-Type': 'text/plain; charset=utf-8',
};

export function createBootGet(
  getBoot: () => BootRouteService = () => getSpore().boot,
) {
  return async (_request: Request, { params }: BootRouteContext) => {
    const { mac } = await params;
    const decision = getBoot().decideBoot(mac);
    return new Response(decision.content, {
      status: decision.status,
      headers: ipxeHeaders,
    });
  };
}

export const GET = createBootGet();
