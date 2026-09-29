/** Strings shaped like a key or a bearer, which a provider error or a command can echo. */
export const SECRET_SHAPED =
  /(?:sk-[A-Za-z0-9._-]{8,}|[Bb]earer\s+[A-Za-z0-9._-]{8,}|[A-Za-z0-9_-]{32,})/g;

export function redact(text: string): string {
  return text.replace(SECRET_SHAPED, '[redacted]');
}
