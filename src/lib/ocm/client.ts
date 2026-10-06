import { readFileSync } from "node:fs";

import { toChargers, type Charger, type Position } from "./charger.ts";
import type { OcmPoi } from "./types.ts";

/**
 * Fetching chargers from Open Charge Map, with the recorded fixture as a fallback.
 *
 * ── Why a fallback rather than an error ─────────────────────────────────────────────────────
 *
 * OCM is a non-profit running on donated infrastructure. A demo attached to a blog post that 502s
 * because a volunteer service is having an afternoon teaches the reader that the *idea* does not
 * work, which is not the thing being demonstrated. So an upstream failure falls back to
 * `fixtures/au-chargers.json` — 231 real records pulled on 26th September 2026 — and says so.
 *
 * The fallback is real recorded data, never synthetic. A generated stand-in would put invented
 * access notes in front of a reader in a demo whose entire point is that the real notes are
 * surprising.
 */

const OCM_ENDPOINT = "https://api.openchargemap.io/v3/poi";

/** Attribution. CC BY 4.0 requires it, and it is shown in the UI, not buried here. */
export const OCM_ATTRIBUTION = "Charger data © Open Charge Map contributors, CC BY 4.0";

export interface FetchOptions {
  /** Both ends of the journey. The candidate pool spans the corridor between them. */
  readonly origin: Position;
  readonly destination: Position;
  /** Degrees of padding around the corridor. ~0.3 is roughly 33km. */
  readonly padDegrees?: number;
  readonly maxResults: number;
  readonly signal?: AbortSignal;
}

export interface ChargerSource {
  readonly chargers: readonly Charger[];
  readonly live: boolean;
  /** Present when the live call failed and the fixture was used instead. */
  readonly fallbackReason: string | null;
  readonly dropped: number;
}

let cachedFixture: readonly OcmPoi[] | null = null;

function loadFixture(): readonly OcmPoi[] {
  cachedFixture ??= JSON.parse(
    readFileSync(new URL("../../../fixtures/au-chargers.json", import.meta.url), "utf8"),
  ) as readonly OcmPoi[];
  return cachedFixture;
}

function fromFixture(reason: string | null): ChargerSource {
  const { chargers, dropped } = toChargers(loadFixture());
  return { chargers, live: reason === null, fallbackReason: reason, dropped };
}

/**
 * Fetch chargers near a point.
 *
 * `verbose=true` is required for the expanded `OperatorInfo`, `UsageType` and `StatusType` titles.
 * `includecomments=true` adds `UserComments`, which is judgement material and worth the bytes.
 */
export async function fetchChargers(options: FetchOptions): Promise<ChargerSource> {
  const apiKey = process.env["OCM_API_KEY"];
  if (apiKey === undefined || apiKey.trim() === "") {
    return fromFixture("OCM_API_KEY is not set");
  }

  // A bounding box over the whole journey, not a radius around the start.
  //
  // It was a fixed 40km radius from the origin, and that silently broke the thing the battery slider
  // is supposed to demonstrate: at 10% battery a driver can reach 34km, at 70% they can reach 238km,
  // and yet the candidate pool never extended past 40km so the shortlist came back *identical* at
  // both. Measured on Melbourne to Geelong: the radius found 117 chargers, all clustered at the
  // Melbourne end; the corridor box finds 143, of which 16 are near Geelong and only become reachable
  // once the battery allows it.
  const pad = options.padDegrees ?? 0.3;
  const south = Math.min(options.origin.lat, options.destination.lat) - pad;
  const north = Math.max(options.origin.lat, options.destination.lat) + pad;
  const west = Math.min(options.origin.lon, options.destination.lon) - pad;
  const east = Math.max(options.origin.lon, options.destination.lon) + pad;

  const url = new URL(OCM_ENDPOINT);
  url.searchParams.set("output", "json");
  url.searchParams.set("countrycode", "AU");
  url.searchParams.set("boundingbox", `(${south},${west}),(${north},${east})`);
  url.searchParams.set("maxresults", String(options.maxResults));
  url.searchParams.set("verbose", "true");
  url.searchParams.set("includecomments", "true");

  try {
    const response = await fetch(url, {
      headers: { "X-API-Key": apiKey },
      // Its own timeout. A slow upstream must not hold the page open indefinitely, and the fixture
      // is right there.
      signal: options.signal ?? AbortSignal.timeout(8_000),
    });

    if (!response.ok) {
      return fromFixture(`Open Charge Map returned ${response.status}`);
    }

    const body: unknown = await response.json();
    if (!Array.isArray(body)) {
      return fromFixture("Open Charge Map returned something that was not a list");
    }

    const { chargers, dropped } = toChargers(body as readonly OcmPoi[]);
    // An empty live response is a real answer (nowhere to charge), not a failure. But zero chargers
    // from a corridor spanning two Australian towns is far more likely to be a quota problem, and
    // showing the reader an empty map would misattribute it to the idea rather than the plumbing.
    if (chargers.length === 0) {
      return fromFixture("Open Charge Map returned no usable chargers");
    }
    return { chargers, live: true, fallbackReason: null, dropped };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Open Charge Map could not be reached";
    return fromFixture(reason);
  }
}
