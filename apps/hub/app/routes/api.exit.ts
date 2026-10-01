import { authorizeExit } from '~/lib/exit-guard';
import type { Route } from './+types/api.exit';

const json = (body: unknown, status: number, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

// A GET never restarts the process: only the POST action does.
export async function loader() {
  return json({ message: 'Method not allowed' }, 405, { Allow: 'POST' });
}

// Exits the process so the container runtime restarts it.
export async function action({ request }: Route.ActionArgs) {
  const decision = authorizeExit(request);
  if (!decision.ok) {
    return json({ message: 'Forbidden' }, decision.status, { Allow: 'POST' });
  }

  setTimeout(() => {
    process.exit(0);
  }, 100); // lets the response go out first

  return json({ message: 'Process will exit shortly' }, 200);
}
