'use server';

import { revalidatePath, revalidateTag } from 'next/cache';
import { generateProjectId } from './nanoid';
import { sendOutgoingWebhook } from './outgoing-webhook-sender';
import { getProjectStore } from './project-store-firestore';
import { sanitizeHeaders } from './sanitize-headers';
import { slugSchema } from './slug';
import type { Webhook } from './types';

/**
 * The server seam. Each action is a callable POST endpoint, so each one
 * validates its own input and then hands off to the project store or the
 * SSRF-safe sender. No business rules live here.
 */

function revalidateProjectLists() {
  revalidatePath('/');
  revalidatePath('/', 'layout');
  revalidateTag('projects', 'default');
}

export async function createProjectAction(slug: string) {
  const parsed = slugSchema.safeParse(slug);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message || 'Invalid slug format');
  }

  const store = await getProjectStore();
  const project = await store.createProject(parsed.data);
  revalidateProjectLists();
  return { slug: project.slug };
}

export async function deleteProjectAction(slug: string) {
  const store = await getProjectStore();
  await store.deleteProject(slug);
  revalidateProjectLists();
  return { success: true };
}

export async function listProjectsAction() {
  const store = await getProjectStore();
  return { projects: await store.listProjects() };
}

export async function readFeedAction(slug: string) {
  const store = await getProjectStore();
  const { data, etag } = await store.readFeed(slug);
  return { webhooks: data.webhooks, maxSize: data.maxSize, etag };
}

export async function pollFeedAction(slug: string, knownEtag?: string | null) {
  const store = await getProjectStore();
  const update = await store.readFeedIfChanged(slug, knownEtag);
  if (!update.changed) {
    return { changed: false as const };
  }
  return {
    changed: true as const,
    webhooks: update.data.webhooks,
    maxSize: update.data.maxSize,
    etag: update.etag,
  };
}

export async function pollStatsAction(knownEtag?: string | null) {
  const store = await getProjectStore();
  const update = await store.readStatsIfChanged(knownEtag);
  if (!update.changed) {
    return { changed: false as const };
  }
  return { changed: true as const, stats: update.data, etag: update.etag };
}

export async function clearHistoryAction(slug: string) {
  const store = await getProjectStore();
  await store.clearHistory(slug);
  revalidatePath(`/${slug}`);
  return { success: true };
}

/**
 * Send a request to a user-supplied URL and record it against the project.
 *
 * The only path that records an outgoing webhook. It goes through
 * `sendOutgoingWebhook`, which enforces the domain allowlist and resolved-IP
 * checks on the initial request and on every redirect hop.
 */
export async function sendOutgoingWebhookAction(
  slug: string,
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string | null;
  },
) {
  const url = encodeUrl(request.url);
  const result = await sendOutgoingWebhook(
    url,
    {
      method: request.method,
      headers: request.headers,
      body: request.body,
    },
    { rateLimitKey: slug },
  );

  const webhook: Webhook = {
    id: generateProjectId(),
    method: request.method,
    url,
    // Stored headers are redacted; the sender redacts separately for the wire.
    headers: sanitizeHeaders(request.headers || {}),
    body: request.body || null,
    timestamp: Date.now(),
    direction: 'outgoing',
    responseStatus: result.status,
    responseBody: result.body.slice(0, 10_000),
    duration: result.duration,
  };

  const store = await getProjectStore();
  await store.recordWebhook(slug, webhook);

  return {
    webhookId: webhook.id,
    status: result.status,
    statusText: result.statusText,
    responseBody: result.body.slice(0, 200),
  };
}

/**
 * Fire a demo request at the project's own endpoint. Callable, so the URL is
 * untrusted and goes through the same SSRF-safe sender.
 */
export async function sendTestWebhookAction(
  webhookUrl: string,
  method = 'POST',
  body?: string,
) {
  const result = await sendOutgoingWebhook(webhookUrl, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Test-Webhook': 'true',
    },
    body: body && ['POST', 'PUT', 'PATCH'].includes(method) ? body : null,
  });

  return {
    status: result.status,
    statusText: result.statusText,
    body: result.body.slice(0, 200),
  };
}

/** Normalise Unicode in a user-supplied URL without rejecting it outright. */
function encodeUrl(input: string): string {
  try {
    return new URL(input).toString();
  } catch {
    return encodeURI(input);
  }
}
