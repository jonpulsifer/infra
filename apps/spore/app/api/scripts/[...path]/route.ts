import { getSpore } from '@/lib/spore';

export interface ScriptRouteDecision {
  readonly status: number;
  readonly content: string;
}

export interface ScriptRouteService {
  renderScript(path: string, macAddress?: string | null): ScriptRouteDecision;
}

type ScriptRouteContext = { params: Promise<{ path: string[] }> };

const ipxeHeaders = {
  'Cache-Control': 'no-store',
  'Content-Type': 'text/plain; charset=utf-8',
};

export function createScriptGet(
  getBoot: () => ScriptRouteService = () => getSpore().boot,
) {
  return async (request: Request, { params }: ScriptRouteContext) => {
    const { path: pathSegments } = await params;
    const macAddress = new URL(request.url).searchParams.get('mac');
    const decision = getBoot().renderScript(pathSegments.join('/'), macAddress);
    return new Response(decision.content, {
      status: decision.status,
      headers: ipxeHeaders,
    });
  };
}

export const GET = createScriptGet();
