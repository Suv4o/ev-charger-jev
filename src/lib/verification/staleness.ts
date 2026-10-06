/**
 * How long since anyone confirmed a charger exists.
 *
 * ── Why this module exists ──────────────────────────────────────────────────────────────────
 *
 * Finding 9: asked how the app decides a charger is reliable, the answer was that it does not. The
 * model read the driver's intent correctly — `reliability`, from a sentence that never uses the word
 * — and the code then dropped that answer on the floor. Meanwhile the one piece of hard evidence in
 * the dataset bearing on whether a charger still works was sitting unread.
 *
 * Measured across the 1,367 Australian records:
 *
 *   0–6 months    112      ← exactly the set OCM flags `IsRecentlyVerified`
 *   6–12 months    67
 *   1–2 years     164
 *   2–5 years     868
 *   over 5 years  156
 *
 * **1,024 of 1,367 — 75% — have not been confirmed in over two years.** A date is present on 100% of
 * them, so this is free signal that was being thrown away.
 *
 * ── Why it is here and not in a question ────────────────────────────────────────────────────
 *
 * Turning a timestamp into an age is arithmetic, and the vendor documents that the model reads dates
 * as text rather than as ordered quantities. Asking "is this date a long time ago?" is the single
 * most reliable way to get a confidently wrong answer out of it. So the date never leaves code; only
 * the resulting word does, and only when a question needs one.
 */

/** Ordered, worst last. A rubric in the code's own vocabulary. */
export type Freshness = "fresh" | "recent" | "ageing" | "stale" | "abandoned" | "unknown";

const DAY_MS = 86_400_000;

/** Days since the timestamp, or null if it is missing or unparseable. */
export function daysSince(iso: string | null, now: number): number | null {
  if (iso === null) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const days = (now - then) / DAY_MS;
  // A future date means a bad record, not a very fresh one.
  return days < 0 ? null : days;
}

/**
 * Bucket an age.
 *
 * The boundaries are the measured distribution rather than round numbers picked for looking tidy:
 * six months separates the `IsRecentlyVerified` set from everything else, and two years is where the
 * bulk of the data sits and therefore where "nobody has looked at this in a long time" starts to mean
 * something.
 */
export function freshnessFor(iso: string | null, now: number): Freshness {
  const days = daysSince(iso, now);
  if (days === null) return "unknown";
  if (days <= 180) return "fresh";
  if (days <= 365) return "recent";
  if (days <= 730) return "ageing";
  if (days <= 1825) return "stale";
  return "abandoned";
}

/** Plain English, for the interface and for a reason line. */
export function freshnessLabel(freshness: Freshness, days: number | null): string {
  switch (freshness) {
    case "fresh":
      return "confirmed working in the last few months";
    case "recent":
      return "last confirmed within the year";
    case "ageing":
      return "not confirmed for over a year";
    case "stale":
      return days === null
        ? "not confirmed for years"
        : `not confirmed for about ${Math.round(days / 365)} years`;
    case "abandoned":
      return "not confirmed for over five years";
    case "unknown":
      return "never confirmed";
  }
}

/**
 * Is this too stale to offer a driver who specifically asked for something that will work?
 *
 * Only consulted when the driver's priority is `reliability`. A stricter rule applied to everyone
 * would eliminate three quarters of the dataset and make the demo useless — and for a driver who
 * asked for the cheapest option, a five-year-old record is a risk they did not say they minded.
 *
 * That asymmetry is the point of reading the priority at all.
 */
export function tooStaleForReliability(freshness: Freshness): boolean {
  return freshness === "stale" || freshness === "abandoned" || freshness === "unknown";
}
