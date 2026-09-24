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

/** A body other than `{code, message}`, such as a proxy's HTML, is `HTTP_<status>`. */
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
