import { type NextRequest, NextResponse } from 'next/server';
import { generateProjectId } from '@/lib/nanoid';
import { getProjectStore } from '@/lib/project-store-firestore';
import { checkRateLimit } from '@/lib/rate-limit';
import { sanitizeHeaders } from '@/lib/sanitize-headers';
import { isReservedSlug } from '@/lib/slug';
import type { Webhook } from '@/lib/types';

const MAX_BODY_SIZE = 5 * 1024 * 1024; // 5MB

/**
 * Webhook ingestion for `/api/{slug}`. Accepts any method, rate limits per
 * project at 5 RPS, and records the request through the project store.
 */

function rateLimitHeaders(result: {
  limit: number;
  remaining: number;
  reset: number;
}): Record<string, string> {
  return {
    'X-RateLimit-Limit': result.limit.toString(),
    'X-RateLimit-Remaining': result.remaining.toString(),
    'X-RateLimit-Reset': result.reset.toString(),
  };
}

async function handleWebhook(request: NextRequest, slug: string) {
  const rateLimit = checkRateLimit(slug);
  if (!rateLimit.success) {
    return NextResponse.json(
      {
        error: 'Rate limit exceeded',
        limit: rateLimit.limit,
        reset: rateLimit.reset,
      },
      {
        status: 429,
        headers: {
          ...rateLimitHeaders(rateLimit),
          'Retry-After': Math.ceil(
            (rateLimit.reset - Date.now()) / 1000,
          ).toString(),
        },
      },
    );
  }

  const rawHeaders: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    rawHeaders[key] = value;
  });

  const contentLength = request.headers.get('content-length');
  if (contentLength && Number.parseInt(contentLength, 10) > MAX_BODY_SIZE) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }

  let body: string | null = null;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_SIZE) {
      return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
    }
    body = text || null;
  } catch {
    // An empty or unreadable body is not an error for a capture tool.
    body = null;
  }

  const webhook: Webhook = {
    id: generateProjectId(),
    method: request.method,
    url: request.url,
    headers: sanitizeHeaders(rawHeaders),
    body,
    timestamp: Date.now(),
    direction: 'incoming',
    ip:
      request.headers.get('x-forwarded-for') ||
      request.headers.get('x-real-ip') ||
      undefined,
    userAgent: request.headers.get('user-agent') || undefined,
  };

  try {
    const store = await getProjectStore();
    await store.recordWebhook(slug, webhook);
    return NextResponse.json(
      { success: true, webhookId: webhook.id, timestamp: webhook.timestamp },
      { status: 200, headers: rateLimitHeaders(rateLimit) },
    );
  } catch (error) {
    console.error('Failed to record webhook:', error);
    return NextResponse.json(
      { error: 'Failed to save webhook' },
      { status: 500 },
    );
  }
}

async function ingest(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  if (isReservedSlug(slug)) {
    return NextResponse.json({ error: 'Invalid endpoint' }, { status: 404 });
  }

  const store = await getProjectStore();
  if (!(await store.projectExists(slug))) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  return handleWebhook(request, slug);
}

export const GET = ingest;
export const POST = ingest;
export const PUT = ingest;
export const PATCH = ingest;
export const DELETE = ingest;
export const HEAD = ingest;
export const OPTIONS = ingest;
