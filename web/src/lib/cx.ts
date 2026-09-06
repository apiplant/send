/**
 * Joins class names, dropping the falsy ones. Solid 2 dropped `classList`, so
 * conditional styling is built as a plain string.
 */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}
