import type { Position } from "../ocm/charger.ts";

/**
 * Road routing, for drawing only.
 *
 * ── What this is and is not allowed to affect ───────────────────────────────────────────────
 *
 * This draws a line on a map. It does **not** feed the arithmetic. Every distance the app reasons
 * with — reachability, detour, minutes plugged in — stays straight-line, computed in `geo/distance`,
 * and the interface says so.
 *
 * That is a deliberate choice rather than laziness. The OSRM demo server is explicitly a testing
 * service with no availability guarantee, and a shortlist that silently changes shape depending on
 * whether a volunteer server answered would be far worse than one that is consistently approximate.
 * So routing is decoration that degrades to a straight line, and the numbers never depend on it.
 *
 * The gap is real and worth showing: Melbourne to Geelong is 64.6km straight-line and **74.5km** by
 * road. The app reports the road figure alongside its own, so a reader can see the size of the
 * approximation rather than take it on trust.
 */

const OSRM = "https://router.project-osrm.org/route/v1/driving";

export interface RouteResult {
  /** [lon, lat] pairs, ready for a GeoJSON LineString. */
  readonly coordinates: readonly (readonly [number, number])[];
  readonly drivingKm: number;
  readonly drivingMinutes: number;
  /** False when routing failed and this is the straight-line fallback. */
  readonly real: boolean;
}

interface OsrmResponse {
  readonly code?: string;
  readonly routes?: readonly {
    readonly distance?: number;
    readonly duration?: number;
    readonly geometry?: { readonly coordinates?: readonly (readonly [number, number])[] };
  }[];
}

function straightLine(points: readonly Position[]): RouteResult {
  return {
    coordinates: points.map((p) => [p.lon, p.lat] as const),
    drivingKm: 0,
    drivingMinutes: 0,
    real: false,
  };
}

/**
 * Route through an ordered list of points.
 *
 * Two points is origin → destination. Three is origin → charger → destination, which is what a
 * reader gets when they click a charger: the actual shape of the detour, rather than a number
 * claiming one.
 */
export async function routeThrough(
  points: readonly Position[],
  signal?: AbortSignal,
): Promise<RouteResult> {
  if (points.length < 2) return straightLine(points);

  const path = points.map((p) => `${p.lon},${p.lat}`).join(";");
  const url = `${OSRM}/${path}?overview=full&geometries=geojson`;

  try {
    const response = await fetch(url, {
      signal: signal ?? AbortSignal.timeout(6_000),
      headers: { "User-Agent": "jev-ev-charger-demo/0.1 (blog article experiment)" },
    });
    if (!response.ok) return straightLine(points);

    const body = (await response.json()) as OsrmResponse;
    const route = body.routes?.[0];
    const coordinates = route?.geometry?.coordinates;
    if (body.code !== "Ok" || coordinates === undefined || coordinates.length < 2) {
      return straightLine(points);
    }

    return {
      coordinates,
      drivingKm: Math.round(((route?.distance ?? 0) / 1000) * 10) / 10,
      drivingMinutes: Math.round((route?.duration ?? 0) / 60),
      real: true,
    };
  } catch {
    // A volunteer routing service having an afternoon must not break the page.
    return straightLine(points);
  }
}
