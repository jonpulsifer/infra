import type { NextRequest } from 'next/server';
import { getSetting } from '@/lib/actions';
import { resolveBootScript, resolveServerOrigin } from '@/lib/boot-resolver';
import { normalizeMac } from '@/lib/ipxe';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ mac: string }> },
) {
  const { mac: rawMac } = await params;

  let mac: string;
  try {
    mac = normalizeMac(rawMac);
  } catch {
    return new Response(`#!ipxe\necho Invalid MAC address: ${rawMac}\nexit\n`, {
      status: 400,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  const configuredOrigin = await getSetting('serverOrigin');
  const serverOrigin = resolveServerOrigin(request, configuredOrigin);

  const script = await resolveBootScript(mac, serverOrigin);

  return new Response(script, {
    headers: { 'Content-Type': 'text/plain' },
  });
}
