import { z } from "zod";

/**
 * A timestamp accepted on the public API: a `Date`, or an ISO-8601 string that
 * carries an explicit offset or `Z`. Strings without an offset are rejected so a
 * value's instant is never silently reinterpreted in the server's time zone.
 */
export const timestampSchema = z.union([
  z.date(),
  z.iso.datetime({ offset: true }),
]);

export type TimestampInput = z.input<typeof timestampSchema>;

/** Canonical UTC ISO-8601 rendering of a validated timestamp. */
export function normalizeTimestamp(timestamp: Date | string): string {
  return timestamp instanceof Date
    ? timestamp.toISOString()
    : new Date(timestamp).toISOString();
}

/** Epoch milliseconds for a validated timestamp (used for ordering checks). */
export function timestampMilliseconds(timestamp: Date | string): number {
  return timestamp instanceof Date
    ? timestamp.getTime()
    : Date.parse(timestamp);
}

/**
 * Render a half-open `[start,end)` tstzrange literal from two timestamps,
 * enforcing `start < end`. Returns `null` describing the failure via `issue`
 * when the interval is empty or inverted, so callers can attach their own path.
 */
export function normalizeRangeLiteral(
  start: Date | string,
  end: Date | string,
): { readonly literal: string } | { readonly error: string } {
  if (timestampMilliseconds(start) >= timestampMilliseconds(end)) {
    return { error: "interval start must be before its end" };
  }
  return {
    literal: `[${normalizeTimestamp(start)},${normalizeTimestamp(end)})`,
  };
}
