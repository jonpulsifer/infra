import type { NativeBootDecision } from '@/lib/boot-decision';
import { getSpore } from '@/lib/spore';

export interface NativeBootRouteService {
  resolveNativeBoot(
    target: string,
    artifact: string,
    squashfsDigest?: string | null,
  ): NativeBootDecision;
}

type NativeBootRouteContext = {
  params: Promise<{ target: string; artifact: string }>;
};

export function createNativeBootGet(
  getBoot: () => NativeBootRouteService = () => getSpore().boot,
) {
  return async (request: Request, { params }: NativeBootRouteContext) => {
    const { target, artifact } = await params;
    const digest = new URL(request.url).searchParams.get('sha256');
    const decision = getBoot().resolveNativeBoot(target, artifact, digest);
    const headers = new Headers({
      'Cache-Control': 'no-store',
      'Content-Type': 'application/octet-stream',
    });
    if (decision.internalPath) {
      headers.set('X-Accel-Redirect', decision.internalPath);
    }
    return new Response(null, { status: decision.status, headers });
  };
}

export const GET = createNativeBootGet();
