export class Health {
  linked = false;

  fetch(request: Request): Response {
    const { pathname } = new URL(request.url);
    if (pathname !== '/healthz')
      return new Response('not found', { status: 404 });
    return this.linked
      ? new Response('ok')
      : new Response('mate link down', { status: 503 });
  }
}
