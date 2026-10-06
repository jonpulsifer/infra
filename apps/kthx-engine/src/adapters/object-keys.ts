/**
 * A label or annotation key the engine puts on what it places. Each key lives
 * under `kthx.dev/` and has a twin under the legacy `spindrift.dev/` domain.
 * The engine writes both and reads the new key first, so an object written
 * before the move still reads.
 */
export interface ObjectKey {
  readonly key: string;
  readonly legacy: string;
}

/** Both twins, set to one value. */
export function stamped(key: ObjectKey, value: string): Record<string, string> {
  return { [key.legacy]: value, [key.key]: value };
}

/** The new key's value, or the legacy twin's when only it is present. */
export function readKey(
  values: Readonly<Record<string, string>> | undefined,
  key: ObjectKey,
): string | undefined {
  return values?.[key.key] ?? values?.[key.legacy];
}
