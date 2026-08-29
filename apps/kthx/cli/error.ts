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
