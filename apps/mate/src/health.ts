export class Health {
  connected = false;

  fetch(request: Request): Response {
    const { pathname } = new URL(request.url);
    if (pathname !== '/healthz')
      return new Response('not found', { status: 404 });
    return this.connected
      ? new Response('ok')
      : new Response('gateway disconnected', { status: 503 });
  }
}
