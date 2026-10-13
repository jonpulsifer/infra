export type Handler = (request: Request) => Response | Promise<Response>;

/** The process's one HTTP port: the readiness probe, and the routes a running mate adds. */
export class Routes {
  private readonly handlers = new Map<string, Handler>();

  /** `null` removes the route. */
  set(path: string, handler: Handler | null): void {
    if (handler) this.handlers.set(path, handler);
    else this.handlers.delete(path);
  }

  fetch(request: Request): Response | Promise<Response> {
    const handler = this.handlers.get(new URL(request.url).pathname);
    return handler
      ? handler(request)
      : new Response('not found', { status: 404 });
  }
}
