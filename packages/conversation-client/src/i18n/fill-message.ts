/**
 * A message with its `{name}` placeholders filled in one pass.
 *
 * Filling one placeholder after another re-read the text already put in: a chart titled "Top {count}" had its own
 * "{count}" replaced by the number of points when the count was filled next. Here every placeholder is found in the
 * template first, so a value is never read again, whatever braces or `$&` it holds. A placeholder with no value is left
 * as it is, so a missing value shows rather than vanishing.
 */
export function fillMessage(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/gu, (whole, name: string) => (Object.hasOwn(values, name) ? String(values[name]) : whole));
}
