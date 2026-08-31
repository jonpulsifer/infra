/** A failure the CLI prints as `CODE: message` and exits 1 on. */
export class KthxError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'KthxError';
  }
}

/**
 * The refusal a response carries, as the error to throw.
 *
 * Every route answers a refusal as `{code, message}`; a route that answers
 * something else — a proxy's HTML, an empty body — becomes `HTTP_<status>`.
 */
export async function refusal(response: Response): Promise<KthxError> {
  const body = (await response.json().catch(() => ({}))) as {
    code?: unknown;
    message?: unknown;
  };
  return new KthxError(
    typeof body.code === 'string' ? body.code : `HTTP_${response.status}`,
    typeof body.message === 'string' ? body.message : response.statusText,
  );
}
