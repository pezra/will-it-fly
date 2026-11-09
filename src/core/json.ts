/** `JSON.parse` that reports a syntax error as a value instead of throwing. */
export function tryParseJSON(
  text: string,
): { ok: true; value: unknown } | { ok: false; error: unknown } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error };
  }
}
