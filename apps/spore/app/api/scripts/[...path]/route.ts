import { eq } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { getSetting } from '@/lib/actions';
import { resolveServerOrigin } from '@/lib/boot-resolver';
import { db, scripts } from '@/lib/db';
import { buildTemplateContext, processTemplate } from '@/lib/ipxe';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path: pathSegments } = await params;
  const scriptPath = pathSegments.join('/');

  // Look up the script
  const script = await db
    .select()
    .from(scripts)
    .where(eq(scripts.path, scriptPath))
    .get();

  if (!script) {
    return new Response(
      `#!ipxe\necho Script not found: ${scriptPath}\nsleep 3\nexit\n`,
      {
        status: 404,
        headers: { 'Content-Type': 'text/plain' },
      },
    );
  }

  // Get server origin for template variables
  const configuredOrigin = await getSetting('serverOrigin');
  const serverOrigin = resolveServerOrigin(request, configuredOrigin);

  // Try to get MAC from query params (optional, for template context)
  const mac = request.nextUrl.searchParams.get('mac') || '00:00:00:00:00:00';

  // Build a minimal template context (host-specific vars will be generic)
  const context = buildTemplateContext(mac, null, null, serverOrigin);
  const content = processTemplate(script.content, context);

  return new Response(content, {
    headers: { 'Content-Type': 'text/plain' },
  });
}
