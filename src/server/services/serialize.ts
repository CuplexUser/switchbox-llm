/**
 * Converts a repository row into its wire shape. Rows carry Date objects, while the shared DTOs
 * use ISO strings, which is exactly what JSON produces.
 */
export function serialize<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Converts ISO date strings from an import bundle back into Dates for the given fields. */
export function reviveDates<T extends Record<string, unknown>>(row: T, fields: string[]): T {
  const copy: Record<string, unknown> = { ...row };
  for (const field of fields) {
    const value = copy[field];
    if (typeof value === 'string') copy[field] = new Date(value);
  }
  return copy as T;
}
